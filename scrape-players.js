/**
 * Fairway Five — player data scraper
 *
 * WHY THIS EXISTS
 * DGPT.com's standings page is WordPress with the actual table populated
 * client-side via a JS call to /wp-admin/admin-ajax.php after page load, so
 * a plain fetch() of the page itself only gets the empty shell. This scraper
 * replicates that AJAX call directly (see getStandings()) — the nonce/token
 * and page_id it needs are embedded in the plain HTML of the standings page,
 * so no JS execution is required, just a regex to pull them out first.
 * PDGA.com is server-rendered normally and needs no such trick.
 *
 * SOURCES USED
 * 1. Standings + real PDGA#:  https://www.dgpt.com/full-standings/?division={MPO|FPO}
 *                                (via its own admin-ajax.php action=get_standings —
 *                                 each row's data-pdgaid attribute is the athlete's
 *                                 actual PDGA number, straight from DGPT itself)
 * 2. C1X putting %:            https://statmando.com/stats/season-stats-putt-dgpt-{year}-{mpo|fpo}
 *                                (DGPT's own standings response doesn't include
 *                                 putting stats, so this one still comes from StatMando)
 * 3. Hometown + rating +       https://www.pdga.com/player/{pdgaNumber}
 *    2026 results by tier         (Location, "Current Rating", and a table of this
 *                                   year's events each tagged with a Tier: M, ES, A, B, C, XC)
 *
 * This design means there's no manual name->PDGA# lookup table anymore — DGPT's
 * own data provides the real number for every player, including new entrants
 * who rotate into the top 40 mid-season. Verified live on 09-Jul-2026.
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

// 1. Standings: rank + player name + REAL PDGA number, straight from DGPT's
// own site. DGPT's standings page is client-rendered — the table itself is
// populated by a JS call to /wp-admin/admin-ajax.php (action=get_standings)
// after page load. That call needs a WordPress nonce ("token") and the
// page's internal page_id, both of which are embedded in the plain HTML of
// the standings page itself (no JS execution needed to read them — just
// regex them out before making the POST).
//
// Crucially, each returned <tr> carries data-pdgaid="..." — the athlete's
// actual PDGA number — eliminating the need for any manual name->PDGA#
// lookup table. This replaces the previous statmando.com-based approach
// entirely for standings; statmando is still used separately for C1X%
// (DGPT's own standings response doesn't include putting stats).
async function getStandings(division) {
  const pageHtml = await fetchHtml(`https://www.dgpt.com/full-standings/?division=${division}`);

  const tokenMatch = pageHtml.match(/"token"\s*:\s*"([a-f0-9]{32})"/i)
    || pageHtml.match(/token['"]?\s*[:=]\s*['"]([a-f0-9]{32})['"]/i);
  const pageIdMatch = pageHtml.match(/"page_id"\s*:\s*"?(\d+)"?/i)
    || pageHtml.match(/page_id['"]?\s*[:=]\s*['"]?(\d+)['"]?/i);

  if (!tokenMatch || !pageIdMatch) {
    throw new Error(
      `Could not find the DGPT AJAX token/page_id in the ${division} standings page — ` +
      `DGPT's page markup may have changed. Inspect the raw HTML around where the stats ` +
      `module is initialized (search for "token" or "page_id") and update the regexes in getStandings().`
    );
  }

  const token = tokenMatch[1];
  const pageId = pageIdMatch[1];

  const body = new URLSearchParams({
    action: 'get_standings',
    page_id: pageId,
    token: token,
    division: division,
    league: 'dgpt',
  });

  const res = await fetch('https://www.dgpt.com/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': `https://www.dgpt.com/full-standings/?division=${division}`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`DGPT standings AJAX request failed for ${division}: ${res.status}`);
  const html = await res.text();

  const $ = cheerio.load(html);
  const rows = [];
  $('tr[data-pdgaid]').each((i, el) => {
    const pdga = parseInt($(el).attr('data-pdgaid'), 10);
    const rank = parseInt($(el).find('.DGPTStandings--table_rank span').first().text().trim(), 10);
    const name = $(el).find('.DGPTStandings--table_name span').first().text().trim();
    const imgSrc = $(el).find('.DGPTStandings--table_headshot img').first().attr('src') || null;
    // DGPT falls back to a generic silhouette for players without a real
    // photo on file — treat that as "no photo" rather than a real headshot.
    const photo = (imgSrc && !imgSrc.includes('GENERIC PROFILE')) ? imgSrc : null;
    if (pdga && name && !isNaN(rank)) {
      rows.push({ rank, name, pdga, photo });
    }
  });

  if (rows.length === 0) {
    throw new Error(`Parsed 0 standings rows for ${division} — the AJAX response markup may have changed, check getStandings()`);
  }

  return rows.sort((a, b) => a.rank - b.rank).slice(0, TOP_N);
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

  // Walk the results table(s); collect rows whose Tier column is M or ES,
  // track the best (lowest) Place, and remember every tournament tied at
  // that place — not just the first one encountered.
  let bestPlace = null;
  let bestTourneys = [];
  $('table tr').each((i, el) => {
    const cells = $(el).find('td');
    if (cells.length < 5) return;
    const place = parseInt($(cells[0]).text().trim(), 10);
    const tier = $(cells[3]).text().trim(); // column order: Place, Points, Tournament, Tier, Dates, Prize
    const tourney = $(cells[2]).text().trim();
    if ((tier === 'M' || tier === 'ES') && !isNaN(place)) {
      if (bestPlace === null || place < bestPlace) {
        bestPlace = place;
        bestTourneys = [{ tourney, tier }];
      } else if (place === bestPlace) {
        bestTourneys.push({ tourney, tier });
      }
    }
  });

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

  return { hometown, rating, majorFinish };
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
    // s.pdga is the athlete's real PDGA number, straight from DGPT's own
    // standings data (data-pdgaid attribute) — no manual lookup needed.
    const pdgaNumber = s.pdga;

    let profile;
    try {
      profile = await getPdgaProfile(pdgaNumber);
    } catch (err) {
      console.error(`Failed to fetch profile for ${s.name} (#${pdgaNumber}): ${err.message}`);
      const old = existingByPdga.get(pdgaNumber);
      // Fall back to whatever we already had rather than dropping the player
      // or crashing the whole run over one flaky request.
      profile = old
        ? { hometown: old.hometown, rating: old.rating, majorFinish: old.majorFinish }
        : { hometown: null, rating: null, majorFinish: null };
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
      photo: s.photo ?? (existingByPdga.get(pdgaNumber)?.photo ?? null),
    });
    // Be polite — a real delay with jitter between requests, since GitHub
    // Actions IPs get rate-limited much faster than a normal browsing pace.
    await sleep(jitter(1800));
  }
  return players;
}

// NOTE: the manual PDGA_NUMBER_LOOKUP table that used to live here has been
// removed. getStandings() now pulls PDGA numbers directly from DGPT's own
// data (data-pdgaid attributes), which is both more accurate and immune to
// the "new player rotated into the top 40" problem entirely — no more
// manual upkeep needed as standings shift over the season.

async function refreshPartial(existingPlayers) {
  const updated = [];
  for (const p of existingPlayers) {
    try {
      const profile = await getPdgaProfile(p.pdga);
      updated.push({ ...p, rating: profile.rating, majorFinish: profile.majorFinish });
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
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
