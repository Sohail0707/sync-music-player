// netlify/functions/upload-url.js
// POST /api/upload-url  { party, filename, contentType, size, password }
//   -> { url, key }   a presigned PUT URL the HOST's browser uploads to directly.
//
// Host-only (needs SMP_HOST_PASSWORD). Enforces hard caps so Cloudflare R2's free
// tier (10 GB storage) is never exceeded:
//   • per-file size limit
//   • max songs per party
//   • global storage ceiling (with safety margin under 10 GB)
const { isValidParty, prefixFor } = require('./_parties');
const { listPlaylist, totalBytes, presignPut } = require('./_r2');

const MAX_SONGS_PER_PARTY = 100;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per song
const MAX_TOTAL_BYTES = 9 * 1024 * 1024 * 1024; // 9 GB ceiling (R2 free tier is 10 GB)

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

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

  const { party, filename, contentType, size, password } = body;

  if (password !== process.env.SMP_HOST_PASSWORD) return json(403, { error: 'Wrong host password.' });
  if (!party || !isValidParty(party)) return json(400, { error: 'Unknown party.' });
  if (!filename) return json(400, { error: 'filename required.' });

  const bytes = Number(size) || 0;
  if (bytes > MAX_FILE_BYTES) {
    return json(413, { error: `File too large. Max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB per song.` });
  }

  try {
    const prefix = prefixFor(party);

    // Cap 1: songs per party.
    const existing = await listPlaylist(prefix);
    if (existing.length >= MAX_SONGS_PER_PARTY) {
      return json(409, { error: `This party is full (${MAX_SONGS_PER_PARTY} songs max).` });
    }

    // Cap 2: global storage — never exceed the free tier.
    const total = await totalBytes();
    if (total + bytes > MAX_TOTAL_BYTES) {
      return json(507, { error: 'Storage is full. Delete some songs before adding more.' });
    }

    const key = `${prefix}${Date.now()}-${sanitize(filename)}`;
    const type = contentType || 'audio/mpeg';
    const url = await presignPut(key, type);
    return json(200, { url, key, contentType: type });
  } catch (err) {
    console.error('upload-url error', err);
    return json(500, { error: 'Could not create upload URL.' });
  }
};
