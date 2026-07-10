// /api/record-result.js
//
// Records one completed game's outcome into a Redis hash so a global
// histogram of "how many people finished on each stroke" can be shown.
//
// Requires two Vercel environment variables (set in Project Settings →
// Environment Variables), both from your Upstash Redis database's REST API
// tab:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//
// These stay server-side only — the browser never sees them, since this
// whole file runs on Vercel's servers, not in the player's browser.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { date, div, difficulty, guessCount, won } = req.body || {};

  if (!date || !div || !difficulty) {
    return res.status(400).json({ error: 'Missing date, div, or difficulty' });
  }
  if (!['MPO', 'FPO', 'MIX'].includes(div)) {
    return res.status(400).json({ error: 'Invalid div' });
  }
  if (!['normal', 'easy'].includes(difficulty)) {
    return res.status(400).json({ error: 'Invalid difficulty' });
  }

  // Bucket is "1".."5" for a win on that stroke, or "X" for a loss.
  const bucket = won ? String(guessCount) : 'X';
  if (!['1', '2', '3', '4', '5', 'X'].includes(bucket)) {
    return res.status(400).json({ error: 'Invalid guessCount/won combination' });
  }

  // Keep the key to a safe, predictable charset — date/div/difficulty are
  // all already validated above, so this is just a formatting step.
  const key = `stats:${date}:${div}:${difficulty}`;

  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !restToken) {
    return res.status(500).json({ error: 'Server is missing Upstash credentials' });
  }

  try {
    const url = `${restUrl}/hincrby/${encodeURIComponent(key)}/${encodeURIComponent(bucket)}/1`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${restToken}` },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `Upstash error: ${text}` });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
