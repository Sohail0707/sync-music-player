// netlify/functions/upload-url.js
// POST /api/upload-url  { party, filename, contentType, password }
//   -> { url, key }   a presigned PUT URL the HOST's browser uploads to directly.
//
// Host-only: requires the correct SMP_HOST_PASSWORD, so listeners can't add songs.
const { isValidParty, prefixFor } = require('./_parties');
const { presignPut } = require('./_r2');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// Keep filenames safe for use as object keys.
const sanitize = (name) =>
  name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'track';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST.' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON.' });
  }

  const { party, filename, contentType, password } = body;

  if (password !== process.env.SMP_HOST_PASSWORD) {
    return json(403, { error: 'Wrong host password.' });
  }
  if (!party || !isValidParty(party)) return json(400, { error: 'Unknown party.' });
  if (!filename) return json(400, { error: 'filename required.' });

  // Timestamp prefix keeps uploads unique AND makes the listing chronological.
  const key = `${prefixFor(party)}${Date.now()}-${sanitize(filename)}`;
  const type = contentType || 'audio/mpeg';

  try {
    const url = await presignPut(key, type);
    return json(200, { url, key, contentType: type });
  } catch (err) {
    console.error('upload-url error', err);
    return json(500, { error: 'Could not create upload URL.' });
  }
};
