// netlify/functions/schedule.js
// The authoritative party "schedule" — the single source of truth for playback.
//   GET  /api/schedule?party=X            -> { schedule }
//   POST /api/schedule { party, schedule, password }  (host-only)  -> { ok }
//
// schedule = { trackKey, anchorPos, anchorServerTime, playing, ended, rev }
//   "Track <trackKey> was at <anchorPos>s at server time <anchorServerTime>, playing/paused."
// Any device derives its position from this + the shared server clock — no host needed
// to stay in sync, and a device recovering from background just re-reads this.
//
// Stored in Netlify Blobs (tiny JSON per party; negligible against the free tier).

const { isValidParty } = require('./_parties');

const DEFAULT = { trackKey: null, anchorPos: 0, anchorServerTime: 0, playing: false, ended: false, rev: 0 };

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

// @netlify/blobs is ESM; our functions are CommonJS, so import it dynamically.
async function store() {
  const { getStore } = await import('@netlify/blobs');
  return getStore('schedules');
}

exports.handler = async (event) => {
  // Validate everything BEFORE touching storage (cheap rejects, no Blobs init needed).
  if (event.httpMethod === 'GET') {
    const party = event.queryStringParameters?.party;
    if (!party || !isValidParty(party)) return json(400, { error: 'Unknown party.' });
    try {
      const schedule = (await (await store()).get(party, { type: 'json' })) || DEFAULT;
      return json(200, { schedule });
    } catch (err) {
      console.error('schedule GET error', err);
      return json(500, { error: 'Schedule store unavailable.' });
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON.' });
    }
    const { party, schedule, password } = body;
    if (password !== process.env.SMP_HOST_PASSWORD) return json(403, { error: 'Wrong host password.' });
    if (!party || !isValidParty(party)) return json(400, { error: 'Unknown party.' });
    if (!schedule || typeof schedule !== 'object') return json(400, { error: 'Missing schedule.' });
    try {
      await (await store()).setJSON(party, schedule);
      return json(200, { ok: true });
    } catch (err) {
      console.error('schedule POST error', err);
      return json(500, { error: 'Schedule store unavailable.' });
    }
  }

  return json(405, { error: 'Method not allowed.' });
};
