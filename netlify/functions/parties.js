// netlify/functions/parties.js — GET the list of pre-created parties.
const { PARTIES } = require('./_parties');

exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  body: JSON.stringify({ parties: PARTIES })
});
