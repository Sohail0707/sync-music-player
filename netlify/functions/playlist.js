// netlify/functions/playlist.js
// GET /api/playlist?party=<id>  ->  the party's tracks with presigned download URLs.
const { isValidParty, prefixFor } = require('./_parties');
const { listPlaylist, presignGet } = require('./_r2');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  const party = event.queryStringParameters?.party;
  if (!party || !isValidParty(party)) return json(400, { error: 'Unknown party.' });

  try {
    const prefix = prefixFor(party);
    const objects = await listPlaylist(prefix);

    const tracks = await Promise.all(
      objects.map(async (o) => ({
        key: o.Key,
        // Display name = filename without the "parties/<id>/<timestamp>-" prefix.
        name: decodeURIComponent(o.Key.slice(prefix.length).replace(/^\d+-/, '')),
        url: await presignGet(o.Key)
      }))
    );

    return json(200, { tracks });
  } catch (err) {
    console.error('playlist error', err);
    return json(500, { error: 'Could not load the playlist.' });
  }
};
