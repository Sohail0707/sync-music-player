// netlify/functions/get-token.js
//
// Securely mints LiveKit access tokens. API key + secret NEVER reach the browser —
// they live only in Netlify environment variables and are used here, server-side.
//
// Required Netlify environment variables (Site settings -> Environment variables):
//   LIVEKIT_API_KEY      e.g. "APIxxxxxxxx"
//   LIVEKIT_API_SECRET   e.g. "xxxxxxxxxxxxxxxxxxxx"
//   LIVEKIT_URL          e.g. "wss://your-project.livekit.cloud"
//
// We return the URL too so the frontend never has to hardcode it.

const { AccessToken } = require('livekit-server-sdk');

// Allow the browser (and the PWA origin) to call this function.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // Preflight (browsers send OPTIONS before a JSON POST).
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' })
    };
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'Server misconfigured: missing LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL.'
      })
    };
  }

  // Parse + validate the request body.
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON body.' })
    };
  }

  const { roomName, participantName, isHost } = body;

  if (!roomName || !participantName) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'roomName and participantName are required.' })
    };
  }

  // Identity must be unique within a room. We append a short random suffix so two people
  // can pick the same nickname without colliding (LiveKit kicks duplicate identities).
  const identity = `${String(participantName).slice(0, 32)}__${Math.random().toString(36).slice(2, 8)}`;

  // Build the token. TTL kept reasonable for a long listening session.
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: participantName,
    ttl: '6h'
  });

  // Grant permissions based on role.
  //  - Host:     can publish (broadcast the music) AND subscribe.
  //  - Listener: can subscribe only. canPublish:false prevents listeners from
  //              flooding the room with their own audio.
  at.addGrant({
    roomJoin: true,
    room: String(roomName),
    canPublish: Boolean(isHost),
    canPublishData: Boolean(isHost), // host can send chat/data messages if you extend later
    canSubscribe: true
  });

  // NOTE: in livekit-server-sdk v2, toJwt() is async and returns a Promise.
  const token = await at.toJwt();

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ token, url: livekitUrl, identity })
  };
};
