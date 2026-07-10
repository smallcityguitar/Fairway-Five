// /api/admin-summary.js
//
// One-glance view of how many people have played each division/difficulty
// combination on a given day. Visit this URL directly in a browser —
// returns a simple HTML table, not raw JSON, so there's nothing to parse.
//
// Usage:
//   /api/admin-summary                  -> today (server's UTC date)
//   /api/admin-summary?date=2026-7-10   -> a specific day
//
// Uses the same Upstash env vars as record-result.js / get-stats.js:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const DIVISIONS = ['MPO', 'FPO', 'MIX'];
const DIFFICULTIES = ['normal', 'easy'];
const BUCKETS = ['1', '2', '3', '4', '5', 'X'];

export default async function handler(req, res) {
  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !restToken) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send('<p>Server is missing Upstash credentials.</p>');
  }

  const date = req.query.date || todayEastern();

  const rows = [];
  let grandTotal = 0;

  for (const div of DIVISIONS) {
    for (const difficulty of DIFFICULTIES) {
      const key = `stats:${date}:${div}:${difficulty}`;
      const counts = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, 'X': 0 };
      try {
        const r = await fetch(`${restUrl}/hgetall/${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${restToken}` },
        });
        if (r.ok) {
          const data = await r.json();
          const flat = data.result || [];
          for (let i = 0; i < flat.length; i += 2) {
            const field = flat[i];
            const value = parseInt(flat[i + 1], 10);
            if (field in counts && !isNaN(value)) counts[field] = value;
          }
        }
      } catch (err) {
        // leave this row as all-zero rather than failing the whole page
      }
      const total = BUCKETS.reduce((sum, b) => sum + counts[b], 0);
      grandTotal += total;
      rows.push({ div, difficulty, counts, total });
    }
  }

  const html = renderPage(date, rows, grandTotal);
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(html);
}

function todayEastern() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function renderPage(date, rows, grandTotal) {
  const rowsHtml = rows.map(r => `
    <tr>
      <td>${r.div}</td>
      <td>${r.difficulty}</td>
      <td class="total">${r.total}</td>
      ${BUCKETS.map(b => `<td>${r.counts[b]}</td>`).join('')}
    </tr>
  `).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fairway Five — Admin Summary</title>
<style>
  body{ font-family:-apple-system,sans-serif; background:#16302A; color:#F2ECDA; padding:24px 16px; margin:0; }
  h1{ font-size:20px; margin:0 0 4px; }
  .sub{ font-size:13px; color:#DCD4B8; margin:0 0 20px; }
  .grand{ font-size:28px; font-weight:700; color:#E8623D; margin:0 0 20px; }
  table{ width:100%; border-collapse:collapse; background:#F2ECDA; color:#12211C; border-radius:8px; overflow:hidden; font-size:14px; }
  th, td{ padding:8px 10px; text-align:center; border-bottom:1px solid #DCD4B8; }
  th{ background:#1E4238; color:#F2ECDA; font-size:12px; text-transform:uppercase; letter-spacing:0.03em; }
  td:first-child, td:nth-child(2){ text-align:left; font-weight:600; }
  .total{ font-weight:700; color:#a8452c; }
  form{ margin-bottom:16px; }
  input{ padding:6px 8px; border-radius:6px; border:none; font-size:14px; }
  button{ padding:6px 12px; border-radius:6px; border:none; background:#E8623D; color:white; font-weight:600; cursor:pointer; }
</style>
</head>
<body>
  <h1>Fairway Five — Play Counts</h1>
  <p class="sub">Date: ${date} (change via ?date=YYYY-M-D in the URL)</p>
  <form>
    <input type="text" name="date" placeholder="e.g. 2026-7-10" value="${date}">
    <button type="submit">View</button>
  </form>
  <p class="grand">${grandTotal} total plays today</p>
  <table>
    <thead>
      <tr>
        <th>Division</th>
        <th>Difficulty</th>
        <th>Total</th>
        <th>1</th><th>2</th><th>3</th><th>4</th><th>5</th><th>X</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</body>
</html>`;
}
