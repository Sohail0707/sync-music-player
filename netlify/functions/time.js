// netlify/functions/time.js
// GET /api/time -> { now }  — the shared clock reference.
// Every device estimates its offset to THIS (server) clock, so synchronization no longer
// depends on the host being awake. NTP-style: the client measures round-trip and offset.
exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify({ now: Date.now() })
});
