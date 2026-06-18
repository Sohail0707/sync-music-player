// netlify/functions/_parties.js
// -----------------------------------------------------------------------------
// The pre-created parties (playlists). Users pick one of these — no free-form
// room names — which caps how much you store in R2.
//
// Each party maps to a key PREFIX in your R2 bucket: parties/<id>/<song files>
// Edit this list to rename / add / remove parties (keep it at ~10 to stay tidy).
// -----------------------------------------------------------------------------

const PARTIES = [
  { id: 'friday-night', name: 'Friday Night' },
  { id: 'chill-vibes', name: 'Chill Vibes' },
  { id: 'workout', name: 'Workout' },
  { id: 'road-trip', name: 'Road Trip' },
  { id: 'study', name: 'Study / Focus' },
  { id: 'bollywood', name: 'Bollywood' },
  { id: 'throwbacks', name: 'Throwbacks' },
  { id: 'party-mix', name: 'Party Mix' },
  { id: 'lofi', name: 'Lo-Fi' },
  { id: 'late-night', name: 'Late Night' }
];

const isValidParty = (id) => PARTIES.some((p) => p.id === id);
const prefixFor = (id) => `parties/${id}/`;

module.exports = { PARTIES, isValidParty, prefixFor };
