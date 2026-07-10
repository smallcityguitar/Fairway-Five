/**
 * Fairway Five — player data scraper
 *
 * WHY THIS EXISTS
 * DGPT.com's standings/stats pages are client-side rendered (React/JS pulling
 * from an internal admin-ajax.php endpoint), so a plain fetch() only gets you
 * the page shell, not the table data. That endpoint also requires a WordPress
 * nonce that's generated inside DGPT's bundled/minified JS rather than being
 * present anywhere in the plain page HTML — which makes it impractical to
 * replicate reliably from outside a real browser (this was attempted and
 * abandoned; see git history / prior version of this file for the attempt).
 * StatMando (the PDGA's stats partner) and PDGA.com itself both serve fully
 * server-rendered HTML for the same underlying data, so this scraper targets
 * those instead. This approach was verified live and is stable.
 *
 * SOURCES USED
 * 1. Standings (rank):      https://statmando.com/rankings/dgpt/{mpo|fpo}
 * 2. C1X putting %:         https://statmando.com/stats/season-stats-putt-dgpt-{year}-{mpo|fpo}
 * 3. Hometown + rating +    https://www.pdga.com/player/{pdgaNumber}
 *    photo + 2026 results      (Location, "Current Rating", a profile photo at
 *    by tier                    a stable /files/styles/large/public/pictures/
 *                                path, and a table of this year's events each
 *                                tagged with a Tier: M, ES, A, B, C, XC)
 *
 * PDGA numbers come from PDGA_NUMBER_LOOKUP below, since StatMando's
 * standings page links use name-based slugs rather than PDGA numbers. This
 * table needs occasional manual upkeep as new players rotate into the top 40
 * over the season — buildDivision() logs a clear warning (and skips that
 * player, rather than crashing) whenever it encounters a name that isn't in
 * the table yet.
 *
 * TWO REFRESH MODES
 *   --mode=full     Rebuilds everything: standings, C1X, hometown, rating, and
 *                    best Major/ES finish. Meant to run weekly (Monday morning).
 *   --mode=partial   Only re-fetches rating + best Major/ES finish (the two
 *                    fields that change fastest — a rating update or a major
 *                    result can land mid-week) and merges them into the
 *                    existing players.json, leaving standings/hometown/C1X
 *                    untouched. Meant to run twice on the second Tuesday of
 *                    each month (that's the PDGA's usual mid-month ratings
 *                    update day). Refuses to run on any other day unless
 *                    called with --force, as a safety net independent of
 *                    whatever cron schedule is calling it.
 *
 * RATE LIMITING
 * PDGA.com returns HTTP 429 fairly readily for requests coming from
 * datacenter IPs like GitHub Actions runners. fetchHtml() retries on 429/503
 * with backoff (respecting a Retry-After header when PDGA sends one), and
 * there's a ~1.8s+jitter delay between each player fetch. If a given
 * player's profile still can't be fetched after retries, that one player
 * falls back to their last-known data (from the existing players.json)
 * instead of crashing the whole run — a single flaky request no longer
 * takes down the entire refresh.
 *
 * HOW TO RUN
 *   node scrape-players.js --mode=full > players.json
 *   node scrape-players.js --mode=partial --in=players.json --out=players.json
 *
 * NOTE ON NETWORK ACCESS
 * This needs to run somewhere with normal internet access — a sandboxed
 * Claude Code/Cowork container, GitHub Actions runner, or your own machine.
 * It won't work from a network-restricted environment that only allows
 * package registries (npm/pypi/etc).
 *
 * AUTOMATION
 * See the accompanying .github/workflows/refresh-data.yml, which runs this
 * on the schedule described above and commits the refreshed players.json
 * back to the repo — same pattern as your GoeringerWallpaper Actions setup.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio'); // npm install cheerio --save

const TOP_N = 40; // per division, matching the agreed scope

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [key, val] = arg.replace(/^--/, '').split('=');
    args[key] = val === undefined ? true : val;
  }
  return args;
}

function isSecondTuesday(date) {
  // Tuesday = 2. Second Tuesday always falls on the 8th–14th of the month.
  return date.getDay() === 2 && date.getDate() >= 8 && date.getDate() <= 14;
}

// GitHub Actions runners share a small pool of well-known IP ranges, and
// PDGA.com rate-limits (HTTP 429) more aggressively from those than from a
// residential IP. This wrapper retries on 429/503 with backoff that respects
// a Retry-After header when PDGA sends one, and otherwise backs off
// exponentially. A realistic browser User-Agent also helps avoid being
// bucketed as an obvious bot.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) { return ms + Math.floor(Math.random() * ms * 0.4); }

async function fetchHtml(url, { retries = 5, baseDelay = 3000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.ok) return res.text();

    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const retryAfterHeader = res.headers.get('retry-after');
      const wait = retryAfterHeader
        ? parseInt(retryAfterHeader, 10) * 1000
        : jitter(baseDelay * Math.pow(2, attempt));
      console.error(`  [${res.status}] ${url} — retrying in ${Math.round(wait/1000)}s (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  throw new Error(`Failed to fetch ${url}: gave up after ${retries} retries`);
}

// 1. Standings: rank + player name + statmando slug
//
// NOTE ON THE DGPT-DIRECT APPROACH (attempted and abandoned):
// DGPT's own standings page carries a client-side AJAX call
// (admin-ajax.php, action=get_standings) whose response includes real
// PDGA numbers and player photos directly via data-pdgaid attributes —
// genuinely better data than what's here. But that call requires a
// WordPress nonce ("token") that isn't present anywhere in the page's
// plain HTML; it's generated inside dgpt_stats_module's bundled/minified
// JS file, which isn't something we can reliably read or replicate from
// outside a real browser. Rather than depend on reverse-engineering a
// private, unversioned bundle (which could also change or break silently
// at any time), this reverts to StatMando, which is stable, server-
// rendered, and has worked reliably throughout this whole project.
// Real PDGA numbers instead come from PDGA_NUMBER_LOOKUP below, and real
// player photos come from PDGA.com's own player pages (see
// getPdgaProfile()) — both proven, stable sources.
async function getStandings(division) {
  const html = await fetchHtml(`https://statmando.com/rankings/dgpt/${division.toLowerCase()}`);
  const $ = cheerio.load(html);
  const rows = [];
  $('table tr').each((i, el) => {
    const cells = $(el).find('td');
    if (cells.length < 3) return;
    const rank = $(cells[0]).text().trim();
    const link = $(cells[2]).find('a').first();
    const name = link.text().replace(/\*/g, '').trim();
    const slug = (link.attr('href') || '').split('/player/')[1]?.split('/')[0];
    if (name && slug && /^\d+$/.test(rank)) {
      rows.push({ rank: parseInt(rank, 10), name, slug });
    }
  });
  // dedupe, keep best (lowest) rank per player, take top N
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.name) || r.rank < seen.get(r.name).rank) seen.set(r.name, r);
  }
  return [...seen.values()].sort((a, b) => a.rank - b.rank).slice(0, TOP_N);
}

// 2. C1X putting % by player name
async function getC1X(division, year = 2026) {
  const html = await fetchHtml(`https://statmando.com/stats/season-stats-putt-dgpt-${year}-${division.toLowerCase()}`);
  const $ = cheerio.load(html);
  const map = new Map();
  $('table tr').each((i, el) => {
    const cells = $(el).find('td');
    if (cells.length < 2) return;
    const name = $(cells[0]).text().replace(/\*/g, '').trim();
    const c1x = parseFloat($(cells[1]).text().trim());
    if (name && !isNaN(c1x)) map.set(name, c1x);
  });
  return map;
}

// 3. PDGA profile: hometown, current rating, best Major/Elite Series finish this year
async function getPdgaProfile(pdgaNumber, year = 2026) {
  const html = await fetchHtml(`https://www.pdga.com/player/${pdgaNumber}`);
  const $ = cheerio.load(html);

  // Search the whole rendered page text for these labels rather than a
  // specific CSS selector — selector guesses are brittle against markup
  // changes, but "Location:" and "Current Rating:" have shown up as
  // consistent plain-text labels on every PDGA player page. Collapsing
  // whitespace makes the regexes resilient to how the HTML happens to be
  // broken across tags/lines.
  const bodyText = $('body').text().replace(/\s+/g, ' ');

  let hometown = null;
  const locMatch = bodyText.match(/Location:\s*(.*?)\s*Classification:/);
  if (locMatch) hometown = locMatch[1].trim();

  let rating = null;
  const ratingMatch = bodyText.match(/Current Rating:\s*(\d{3,4})/);
  if (ratingMatch) rating = parseInt(ratingMatch[1], 10);

  // "Member Since: 2015" is a plain-text label on PDGA profile pages,
  // confirmed via a live fetch. This replaces any attempt to *guess* tenure
  // from the PDGA number itself — those numbers are issued in batches
  // rather than strictly incrementally over time, so deriving a join year
  // from the number would be unreliable. This is the actual, correct value.
  let memberSince = null;
  const memberMatch = bodyText.match(/Member Since:\s*(\d{4})/);
  if (memberMatch) memberSince = parseInt(memberMatch[1], 10);

  // PDGA player photos live at a stable, predictable path
  // (/files/styles/large/public/pictures/picture-...jpg) regardless of
  // surrounding markup/class names, so match on that rather than a
  // brittle selector. Players without an uploaded photo simply won't
  // have a matching <img>, and photo stays null.
  let photo = null;
  const photoImg = $('img[src*="/files/styles/large/public/pictures/"]').first().attr('src');
  if (photoImg) photo = photoImg.startsWith('http') ? photoImg : `https://www.pdga.com${photoImg}`;

  // Walk the results table(s); collect rows whose Tier column is M or ES,
  // track the best (lowest) Place, remember every tournament tied at that
  // place, and also count/average across just those M/ES rows for the
  // eventsPlayed and avgFinish hints — deliberately excluding lower-tier
  // (A/B/C/XC) events so these hints reflect Major/Elite Series-level
  // competition specifically, same scope as majorFinish.
  let bestPlace = null;
  let bestTourneys = [];
  let eventsPlayed = 0;
  let placeSum = 0;
  $('table tr').each((i, el) => {
    const cells = $(el).find('td');
    if (cells.length < 5) return;
    const place = parseInt($(cells[0]).text().trim(), 10);
    const tier = $(cells[3]).text().trim(); // column order: Place, Points, Tournament, Tier, Dates, Prize
    const tourney = $(cells[2]).text().trim();
    if (isNaN(place) || (tier !== 'M' && tier !== 'ES')) return;

    eventsPlayed++;
    placeSum += place;

    if (bestPlace === null || place < bestPlace) {
      bestPlace = place;
      bestTourneys = [{ tourney, tier }];
    } else if (place === bestPlace) {
      bestTourneys.push({ tourney, tier });
    }
  });
  const avgFinish = eventsPlayed > 0 ? Math.round((placeSum / eventsPlayed) * 10) / 10 : null;

  // Fail loudly rather than silently returning nulls — a page that fetched
  // fine (200 OK) but didn't yield a hometown or rating almost certainly
  // means PDGA's markup shifted and these regexes need updating. Throwing
  // here means the caller's existing try/catch will fall back to old data
  // AND print a clear diagnostic, instead of quietly looking like nothing
  // changed (which is what happened when this parsing was CSS-selector based).
  if (!hometown || !rating) {
    throw new Error(`Parsing failed for PDGA #${pdgaNumber} (hometown=${hometown}, rating=${rating}) — PDGA page markup may have changed, check getPdgaProfile()`);
  }

  const majorFinish = bestPlace !== null
    ? `${ordinal(bestPlace)}, ${bestTourneys.map(t => `${t.tourney} (${t.tier})`).join(' & ')}`
    : 'No M/ES finish yet this year';

  return { hometown, rating, majorFinish, photo, eventsPlayed, avgFinish, memberSince };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function buildDivision(division, existingByPdga) {
  const standings = await getStandings(division);
  await sleep(jitter(1500));
  const c1xMap = await getC1X(division);
  await sleep(jitter(1500));
  const players = [];

  for (const s of standings) {
    // Name -> PDGA# comes from PDGA_NUMBER_LOOKUP below, seeded for the top 40
    // in each division. Standings shift over the season, so re-check this
    // mapping periodically and add any new top-40 entrants.
    const pdgaNumber = PDGA_NUMBER_LOOKUP[s.name];
    if (!pdgaNumber) {
      console.error(`No PDGA number on file for ${s.name} — add it to PDGA_NUMBER_LOOKUP`);
      continue;
    }

    let profile;
    try {
      profile = await getPdgaProfile(pdgaNumber);
    } catch (err) {
      console.error(`Failed to fetch profile for ${s.name} (#${pdgaNumber}): ${err.message}`);
      const old = existingByPdga.get(pdgaNumber);
      // Fall back to whatever we already had rather than dropping the player
      // or crashing the whole run over one flaky request.
      profile = old
        ? { hometown: old.hometown, rating: old.rating, majorFinish: old.majorFinish, photo: old.photo, eventsPlayed: old.eventsPlayed, avgFinish: old.avgFinish, memberSince: old.memberSince }
        : { hometown: null, rating: null, majorFinish: null, photo: null, eventsPlayed: null, avgFinish: null };
    }

    players.push({
      name: s.name,
      pdga: pdgaNumber,
      div: division,
      rating: profile.rating,
      hometown: profile.hometown,
      c1x: c1xMap.get(s.name) ?? (existingByPdga.get(pdgaNumber)?.c1x ?? null),
      majorFinish: profile.majorFinish,
      standing: ordinal(s.rank),
      photo: profile.photo ?? (existingByPdga.get(pdgaNumber)?.photo ?? null),
      eventsPlayed: profile.eventsPlayed ?? (existingByPdga.get(pdgaNumber)?.eventsPlayed ?? null),
      avgFinish: profile.avgFinish ?? (existingByPdga.get(pdgaNumber)?.avgFinish ?? null),
      memberSince: profile.memberSince ?? (existingByPdga.get(pdgaNumber)?.memberSince ?? null),
    });
    // Be polite — a real delay with jitter between requests, since GitHub
    // Actions IPs get rate-limited much faster than a normal browsing pace.
    await sleep(jitter(1800));
  }
  return players;
}

// Seed with PDGA numbers (name must match statmando's display name exactly).
// Complete for the top 40 MPO + top 40 FPO Tour standings as of 09-Jul-2026,
// sourced from PDGA.com player pages and tournament roster pages.
const PDGA_NUMBER_LOOKUP = {
  // MPO top 40
  "Gannon Buhr": 75412,
  "Richard Wysocki": 38008,
  "Calvin Heimburg": 45971,
  "Isaac Robinson": 50670,
  "Adam Hammes": 57365,
  "Anthony Barela": 44382,
  "Niklas Anttila": 91249,
  "Gavin Babcock": 80331,
  "Sullivan Tipton": 78817,
  "Luke Taylor": 102119,
  "Eagle McMahon": 37817,
  "Casey White": 81739,
  "Ezra Robinson": 50671,
  "Aaron Gossage": 35449,
  "Zachary Nash": 101197,
  "Joseph Anderson": 122356,
  "Silas Schultz": 79047,
  "Raven Newsom": 88212,
  "Jaden Rye": 153363,
  "Kyle Klein": 85132,
  "Andrew Marwede": 75590,
  "Jake Monn": 98722,
  "Chris Dickerson": 62467,
  "Austin Turner": 54049,
  "Cole Redalen": 79748,
  "Bradley Williams": 31644,
  "Paul Ulibarri": 27171,
  "Paul Krans": 132521,
  "Corey Ellis": 44512,
  "Parker Welck": 39491,
  "Jesse Nieminen": 58923,
  "Mauri Villmann": 107197,
  "Evan Smith": 101574,
  "Jakub Semerád": 91925,
  "Braeden Sides": 129963,
  "Clay Edwards": 91397,
  "Väinö Mäkelä": 59635,
  "Albert Tamm": 76669,
  "Evan Scott": 89394,
  "Robert Burridge": 96512,

  // FPO top 40
  "Ohn Scoggins": 48976,
  "Holyn Handley": 133547,
  "Silva Saarinen": 107335,
  "Missy Gannon": 85942,
  "Henna Blomroos": 59227,
  "Catrina Allen": 44184,
  "Eveliina Salonen": 64927,
  "Ella Hansen": 144112,
  "Valerie Mandujano": 62879,
  "Hanna Huynh": 112647,
  "Kat Mertsch": 99455,
  "Lisa Fajkus": 32654,
  "Jessica Gurthie": 50656,
  "Sintija Klezberga": 229526,
  "Taylor Chocek": 189702,
  "Sofia Donnecke": 185534,
  "Emily Weatherman": 111487,
  "Paige Pierce": 29190,
  "Rebecca Cox": 32917,
  "Raven Klein": 138272,
  "Alexis Mandujano": 62880,
  "Madison Walker": 59431,
  "Heidi Laine": 66599,
  "Kona Star Montgomery": 27832,
  "Rebecca Don": 208576,
  "Eliezra Midtlyng": 198446,
  "Macie Velediaz": 104187,
  "Anneli Tõugjas-Männiste": 85484,
  "Anniken Kristiansen Steen": 109996,
  "Dani K. Hart": 146137,
  "Iida Lehtomäki": 216558,
  "Jennifer Smiley": 184736,
  "Kelley Foster": 152191,
  "Maria Oliva": 63257,
  "Jennifer Allen": 15354,
  "MJ Gager": 146304,
  "Erika Stinchcomb": 71262,
  "Holly Finley": 51277,
  "Ida Emilie Nesse": 181772,
  "Chandler Reigh": 277832,

  // New entrants that rotated into the FPO top 40 over the course of the season
  "Julia Fors": 224238,
  "Amanda Lennartsson": 155026,
  "Kristýna Jurčíková": 210972,
  "Matilda Ringbom": 77385,
};

async function refreshPartial(existingPlayers) {
  const updated = [];
  for (const p of existingPlayers) {
    try {
      const profile = await getPdgaProfile(p.pdga);
      updated.push({ ...p, rating: profile.rating, majorFinish: profile.majorFinish, photo: profile.photo ?? p.photo, eventsPlayed: profile.eventsPlayed ?? p.eventsPlayed, avgFinish: profile.avgFinish ?? p.avgFinish, memberSince: profile.memberSince ?? p.memberSince });
    } catch (err) {
      console.error(`Failed to refresh ${p.name} (#${p.pdga}): ${err.message}`);
      updated.push(p); // keep old values rather than dropping the player
    }
    await sleep(jitter(1800));
  }
  return updated;
}

async function main() {
  const args = parseArgs();
  const mode = args.mode || 'full';
  const outPath = args.out || null;

  if (mode === 'partial') {
    const today = new Date();
    if (!isSecondTuesday(today) && !args.force) {
      console.error(`Not the second Tuesday of the month (today is ${today.toDateString()}) — skipping partial refresh. Use --force to override.`);
      return;
    }
    const inPath = args.in || outPath;
    if (!inPath) {
      console.error('Partial mode needs an existing players.json — pass --in=players.json');
      process.exit(1);
    }
    const existing = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    const refreshed = await refreshPartial(existing);
    const json = JSON.stringify(refreshed, null, 2);
    if (outPath) fs.writeFileSync(outPath, json); else console.log(json);
    writeMetaFile(outPath);
    return;
  }

  // full mode — load whatever's already there (if any) so a flaky fetch for
  // one player falls back to their last-known data instead of vanishing.
  let existingByPdga = new Map();
  const fullInPath = args.in || outPath;
  if (fullInPath && fs.existsSync(fullInPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(fullInPath, 'utf8'));
      existingByPdga = new Map(existing.map(p => [p.pdga, p]));
    } catch (err) {
      console.error(`Couldn't read existing ${fullInPath}, continuing without fallback data: ${err.message}`);
    }
  }

  const mpo = await buildDivision('MPO', existingByPdga);
  const fpo = await buildDivision('FPO', existingByPdga);
  const json = JSON.stringify([...mpo, ...fpo], null, 2);
  if (outPath) fs.writeFileSync(outPath, json); else console.log(json);
  writeMetaFile(outPath);
}

// Hardcoded from the official 2026 PDGA Major/Elite/A-Tier schedule:
// https://www.pdga.com/pdga-documents/tour-documents/2026-pdga-major-elite-atier-event-schedule
// Filtered to Tier=Elite or Tier=M AND Class/Divs="MPO/FPO Only" — this
// excludes age-restricted/amateur/collegiate events that share the same
// tier labels (e.g. US Masters, US Amateur, Junior Worlds, College Nationals)
// but aren't open MPO/FPO pro tour stops. This is static season data, so it
// only needs updating once a year when the next season's schedule is out —
// it does NOT need to be re-scraped live, unlike everything else here.
const MAJOR_ELITE_SCHEDULE_2026 = [
  ['DGPT Supreme Flight Open', '2026-02-27', '2026-03-01'],
  ['DGPT Big Easy Open', '2026-03-13', '2026-03-15'],
  ['DGPT Queen City Classic', '2026-03-27', '2026-03-29'],
  ['PDGA Champions Cup', '2026-04-09', '2026-04-12'],
  ['DGPT Jonesboro Open', '2026-04-17', '2026-04-19'],
  ['DGPT Kansas City Wide Open', '2026-04-24', '2026-04-26'],
  ['DGPT+ The Open at Austin', '2026-05-07', '2026-05-10'],
  ['DGPT+ OTB Open', '2026-05-21', '2026-05-24'],
  ['DGPT+ Northwest Championship', '2026-06-04', '2026-06-07'],
  ['European Open', '2026-06-18', '2026-06-21'],
  ['DGPT Swedish Open', '2026-06-26', '2026-06-28'],
  ['DGPT Ale Open', '2026-07-03', '2026-07-05'],
  ['DGPT Heinola Open', '2026-07-10', '2026-07-12'],
  ['DGPT+ Ledgestone Open', '2026-07-30', '2026-08-02'],
  ['DGPT Discmania Challenge', '2026-08-07', '2026-08-09'],
  ['DGPT Preserve Championship', '2026-08-14', '2026-08-16'],
  ['PDGA Professional Disc Golf World Championships', '2026-08-26', '2026-08-30'],
  ['DGPT Open at Idlewild', '2026-09-04', '2026-09-06'],
  ['DGPT Playoffs - Green Mountain Championship', '2026-09-17', '2026-09-20'],
  ['DGPT Playoffs - MVP Open x OTB', '2026-09-24', '2026-09-27'],
  ['DGPT Championship', '2026-10-15', '2026-10-18'],
];

// "Current" = the most recently STARTED event (start date <= today) — so an
// event that's still ongoing counts as current, not the one before it.
// Returns null if the season hasn't started yet (e.g. run in January).
// Only references an event once it has fully CONCLUDED (end date <= today) —
// not merely started. The scraper's own weekly schedule (Monday full
// refresh) means results for a just-finished weekend event usually ARE
// captured by the following Monday, but an event that's still IN PROGRESS
// obviously can't have its results reflected in the data yet, and shouldn't
// be named as if it were. Returns null if no MPO/FPO Major/Elite event has
// concluded yet this year (e.g. run in January/early February).
function getCurrentMajorEliteEvent() {
  const today = new Date().toISOString().slice(0, 10);
  const concluded = MAJOR_ELITE_SCHEDULE_2026.filter(([, , end]) => end <= today);
  if (concluded.length === 0) return null;
  concluded.sort((a, b) => (a[2] < b[2] ? 1 : -1)); // latest end date first
  const [name, , endDate] = concluded[0];
  return { name, endDate };
}

// Writes a small meta.json alongside players.json, recording when this
// scraper run last actually completed, plus the current/most-recent
// Major or Elite Series event name. Kept as a SEPARATE file rather than
// adding fields to players.json itself, since the game currently expects
// players.json to be a plain array (PLAYERS = await response.json()) — this
// avoids touching that format at all, so nothing existing can break.
function writeMetaFile(outPath) {
  if (!outPath) return;
  const metaPath = path.join(path.dirname(outPath) || '.', 'meta.json');
  const meta = {
    generatedAt: new Date().toISOString(),
    currentMajorEliteEvent: getCurrentMajorEliteEvent(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
