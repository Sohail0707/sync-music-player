// netlify/functions/_parties.js
// -----------------------------------------------------------------------------
// Party registry. Names come from party-names.js (the file you edit). The KEYS
// there are the permanent internal IDs; each maps to an R2 prefix parties/<id>/.
// Renaming a party (its value) never changes its storage location (its key).
// -----------------------------------------------------------------------------

const NAMES = require('./party-names');

const PARTIES = Object.entries(NAMES).map(([id, name]) => ({ id, name }));
const isValidParty = (id) => Object.prototype.hasOwnProperty.call(NAMES, id);
const prefixFor = (id) => `parties/${id}/`;

module.exports = { PARTIES, isValidParty, prefixFor };
