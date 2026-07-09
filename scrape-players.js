/**
 * Fairway Five — player data scraper
 *
 * WHY THIS EXISTS
 * DGPT.com's standings/stats pages are client-side rendered (React pulling from
 * an internal API), so a plain fetch() only gets you the page shell, not the
 * table data. StatMando (the PDGA's stats partner) and PDGA.com itself both
 * serve fully server-rendered HTML for the same data, so this scraper targets
 * those instead. This exact approach was verified live on 09-Jul-2026.
 *
 * SOURCES USED
 * 1. Standings (rank):      https://statmando.com/rankings/dgpt/{mpo|fpo}
 * 2. C1X putting %:         https://statmando.com/stats/season-stats-putt-dgpt-{year}-{mpo|fpo}
 * 3. Hometown + rating +    https://www.pdga.com/player/{pdgaNumber}
 *    2026 results by tier      (Location, "Current Rating", and a table of this
 *                                year's events each tagged with a Tier: M, ES, A, B, C, XC)
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

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FairwayFiveBot/1.0)' }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

// 1. Standings: rank + player name + statmando slug
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

  const location = $('a[href*="/players?City="]').first().text().trim();

  let rating = null;
  $('.field, li, p').each((i, el) => {
    const t = $(el).text();
    if (/Current Rating:/.test(t)) {
      const m = t.match(/Current Rating:\s*(\d+)/);
      if (m) rating = parseInt(m[1], 10);
    }
  });

  // Walk the results table(s); collect rows whose Tier column is M or ES,
  // keep the best (lowest) Place, and remember which tournament it was.
  let best = null;
  $('table tr').each((i, el) => {
    const cells = $(el).find('td');
    if (cells.length < 5) return;
    const place = parseInt($(cells[0]).text().trim(), 10);
    const tier = $(cells[3]).text().trim(); // column order: Place, Points, Tournament, Tier, Dates, Prize
    const tourney = $(cells[2]).text().trim();
    if ((tier === 'M' || tier === 'ES') && !isNaN(place)) {
      if (!best || place < best.place) best = { place, tourney, tier };
    }
  });

  return {
    hometown: location || null,
    rating,
    majorFinish: best ? `${ordinal(best.place)}, ${best.tourney} (${best.tier})` : 'No M/ES finish yet this year',
  };
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function buildDivision(division) {
  const standings = await getStandings(division);
  const c1xMap = await getC1X(division);
  const players = [];

  for (const s of standings) {
    // Name -> PDGA# comes from PDGA_NUMBER_LOOKUP below, seeded for the top 40
    // in each division as of 09-Jul-2026. Standings shift over the season, so
    // re-check this mapping periodically and add any new top-40 entrants.
    const pdgaNumber = PDGA_NUMBER_LOOKUP[s.name];
    if (!pdgaNumber) {
      console.error(`No PDGA number on file for ${s.name} — add it to PDGA_NUMBER_LOOKUP`);
      continue;
    }
    const profile = await getPdgaProfile(pdgaNumber);
    players.push({
      name: s.name,
      pdga: pdgaNumber,
      div: division,
      rating: profile.rating,
      hometown: profile.hometown,
      c1x: c1xMap.get(s.name) ?? null,
      majorFinish: profile.majorFinish,
      standing: ordinal(s.rank),
    });
    // Be polite — small delay between requests
    await new Promise(r => setTimeout(r, 300));
  }
  return players;
}

// Seed with PDGA numbers (name must match statmando's display name exactly).
// Complete for the top 40 MPO + top 40 FPO Tour standings as of 09-Jul-2026,
// sourced from PDGA.com player pages and tournament roster pages.
const PDGA_NUMBER_LOOKUP = {
  // MPO top 40 (DGPT World Standings rank as of 2026-26)
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

  // FPO top 40 (DGPT World Standings rank as of 2026-20)
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
};

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
    await new Promise(r => setTimeout(r, 300));
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

  // full mode
  const mpo = await buildDivision('MPO');
  const fpo = await buildDivision('FPO');
  const json = JSON.stringify([...mpo, ...fpo], null, 2);
  if (outPath) fs.writeFileSync(outPath, json); else console.log(json);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
