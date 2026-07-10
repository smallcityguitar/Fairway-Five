// /api/get-stats.js
//
// Returns the current global histogram — counts of how many recorded games
// finished on each stroke (or failed) — for a given date/division/difficulty.
// Same Upstash env vars as record-result.js; see that file's header comment.

export default async function handler(req, res) {
  const { date, div, difficulty } = req.query;

  if (!date || !div || !difficulty) {
    return res.status(400).json({ error: 'Missing date, div, or difficulty' });
  }

  const key = `stats:${date}:${div}:${difficulty}`;

  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !restToken) {
    return res.status(500).json({ error: 'Server is missing Upstash credentials' });
  }

  try {
    const url = `${restUrl}/hgetall/${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${restToken}` },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `Upstash error: ${text}` });
    }
    const data = await r.json();
    // Upstash's REST HGETALL returns { result: [field1, value1, field2, value2, ...] }
    const flat = data.result || [];
    const counts = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, 'X': 0 };
    for (let i = 0; i < flat.length; i += 2) {
      const field = flat[i];
      const value = parseInt(flat[i + 1], 10);
      if (field in counts && !isNaN(value)) counts[field] = value;
    }
    return res.status(200).json({ counts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
