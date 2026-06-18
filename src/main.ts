// src/main.ts
// -----------------------------------------------------------------------------
// Sync Music Player (SMP) — server-anchored shared timeline.
//
//  Core idea: playback position is a PURE FUNCTION of a shared server clock and a small
//  "schedule" anchor — nobody coordinates in real time.
//      schedule = { trackKey, anchorPos, anchorServerTime, playing }
//      position = playing ? anchorPos + (serverNow - anchorServerTime) : anchorPos
//
//  • Clock reference = the SERVER (/api/time), not the host → host can sleep/leave.
//  • Schedule lives on the server (Netlify Blobs) → late joiners & recovering devices
//    just re-read it; the host is NOT a live coordinator.
//  • Every device (host included) runs the SAME local "follow" loop, self-correcting to
//    the derived position. Only the host may CHANGE the schedule.
//  • LiveKit is used only for instant push of schedule changes + presence + admission.
// -----------------------------------------------------------------------------

import { Room, RoomEvent, type RemoteParticipant } from 'livekit-client';
import QRCode from 'qrcode';

import { api, type Party, type Track } from './api';
import { SyncClock, type Schedule } from './sync';
import { icons } from './icons';
import { Visualizer } from './visualizer';
import './style.css';

const CTRL = 'smp-ctrl';
const SEEK_SECONDS = 10;
const FOLLOW_MS = 1000; // how often each device self-corrects to the timeline
const enc = new TextEncoder();
const dec = new TextDecoder();

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
interface AppState {
  room: Room | null;
  isHost: boolean;
  myName: string;
  party: Party | null;
  hostPassword: string;
  audioEl: HTMLAudioElement | null;
  playlist: Track[];
  currentIndex: number;
  seeking: boolean;
  clock: SyncClock; // offset to SERVER time
  serverSynced: boolean;
  schedule: Schedule | null; // the authoritative timeline anchor
  hostId: string | null; // listener's view of the host participant
  unlocked: boolean; // listener has tapped to allow audio
  listenerPaused: boolean; // listener manually paused — don't auto-resume
  admitted: boolean; // listener has been let in by the host
  ended: boolean; // party ended
  loadedKey: string | null; // track key currently loaded into the audio element
  correcting: boolean; // currently nudging playbackRate (hysteresis flag)
  driftStrikes: number; // consecutive over-deadband readings (debounce)
  timers: number[];
}

// Host-side: people awaiting admission (identity -> display name).
const pendingJoins = new Map<string, string>();
const state: AppState = {
  room: null,
  isHost: false,
  myName: '',
  party: null,
  hostPassword: '',
  audioEl: null,
  playlist: [],
  currentIndex: -1,
  seeking: false,
  clock: new SyncClock(),
  serverSynced: false,
  schedule: null,
  hostId: null,
  unlocked: false,
  listenerPaused: false,
  admitted: false,
  ended: false,
  loadedKey: null,
  correcting: false,
  driftStrikes: 0,
  timers: []
};

// -----------------------------------------------------------------------------
// Markup
// -----------------------------------------------------------------------------
$('#app').innerHTML = /* html */ `
  <!-- LANDING -->
  <main class="screen landing" id="landing">
    <div class="brand">
      <div class="brand-mark">${icons.note}</div>
      <h1>Sync Music Player</h1>
      <p class="wordmark">S·M·P</p>
      <p class="sub">Pick a party. Everyone hears it in sync.</p>
    </div>

    <div class="field">
      <span>Choose a party</span>
      <div id="partyList" class="party-list"><p class="muted-line">Loading parties…</p></div>
    </div>

    <label class="field">
      <span>Your nickname</span>
      <input id="nameInput" type="text" autocomplete="off" placeholder="alex" />
    </label>

    <label class="toggle">
      <input id="hostCheckbox" type="checkbox" />
      <span>Host this party <small>(needs password)</small></span>
    </label>
    <label class="field" id="pwField" hidden>
      <span>Host password</span>
      <input id="pwInput" type="password" autocomplete="off" placeholder="••••••••" />
    </label>

    <button id="enterBtn" class="btn-primary" disabled>Pick a party to continue</button>
    <p id="landingError" class="error" hidden></p>
  </main>

  <!-- PLAYER -->
  <main class="screen player" id="player" hidden>
    <header class="app-bar">
      <div class="ab-left">
        <span id="roleBadge" class="badge">—</span>
        <span id="roomLabel" class="room-label"></span>
      </div>
      <div class="ab-right">
        <span id="syncDot" class="sync-pill" hidden>◑ syncing…</span>
        <span id="memberCount" class="members">${icons.users}<b>1</b></span>
        <span id="statusDot" class="status disconnected" title="connection"></span>
      </div>
    </header>

    <section class="player-card">
      <div class="artwork" id="artwork">
        <canvas class="viz" id="vizCanvas" aria-hidden="true"></canvas>
        <div class="art-icon">${icons.note}</div>
      </div>
      <div class="track-meta">
        <h2 id="playerTitle">Nothing playing</h2>
        <p id="playerArtist">Sync Music Player</p>
      </div>

      <div class="progress" id="progressRow">
        <span id="curTime" class="t">0:00</span>
        <input id="seekBar" class="seek" type="range" min="0" max="1000" value="0" step="1" />
        <span id="totTime" class="t">0:00</span>
      </div>

      <div class="controls" id="controls">
        <button id="prevBtn" class="ctrl" title="Previous" aria-label="Previous">${icons.prev}</button>
        <button id="backBtn" class="ctrl" title="Back ${SEEK_SECONDS}s" aria-label="Rewind">${icons.rewind}</button>
        <button id="playPauseBtn" class="ctrl play" title="Play / Pause" aria-label="Play or pause">${icons.play}</button>
        <button id="fwdBtn" class="ctrl" title="Forward ${SEEK_SECONDS}s" aria-label="Forward">${icons.forward}</button>
        <button id="nextBtn" class="ctrl" title="Next" aria-label="Next">${icons.next}</button>
      </div>
    </section>

    <section class="content" id="content">
      <div class="list-head"><span id="listTitle">Playlist</span><span id="listCount" class="list-count"></span></div>
      <ul id="playlist" class="playlist"></ul>
      <p id="emptyHint" class="empty-hint">No songs in this party yet.</p>
    </section>

    <nav class="bottom-bar">
      <button class="tab" id="addMusicBtn" hidden>${icons.add}<small>Add songs</small></button>
      <button class="tab" id="inviteBtn">${icons.qr}<small>Invite</small></button>
      <button class="tab danger" id="leaveBtn">${icons.leave}<small>Leave</small></button>
    </nav>

    <input id="fileInput" type="file"
      accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.oga,.opus,.aiff,.aif,.caf,audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/x-wav,audio/flac,audio/ogg,audio/*"
      multiple hidden />
  </main>

  <!-- Listener gesture unlock (mobile autoplay) -->
  <div id="unmuteOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <div class="overlay-icon">🔊</div>
      <h2>Join the party</h2>
      <p>Tap to start playing in sync with everyone.</p>
      <button id="unmuteBtn" class="btn-primary big">Tap to Listen in Sync</button>
    </div>
  </div>

  <!-- Listener waiting room (until host admits) -->
  <div id="waitingOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <div class="overlay-icon">⏳</div>
      <h2 id="waitTitle">Asking the host to let you in…</h2>
      <p id="waitMsg">Hang tight — the host will admit you in a moment.</p>
      <div class="spinner" id="waitSpinner"></div>
      <button id="cancelWaitBtn" class="btn-ghost">Cancel</button>
    </div>
  </div>

  <!-- Host join-requests queue -->
  <div id="admitOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <div class="overlay-icon">👋</div>
      <h2>Join requests</h2>
      <p>People want to join your party.</p>
      <ul id="admitList" class="admit-list"></ul>
    </div>
  </div>

  <!-- Invite QR -->
  <div id="inviteOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <button id="closeInviteBtn" class="overlay-close" aria-label="Close">${icons.close}</button>
      <h2>Scan to join 🎉</h2>
      <p>Friends scan this to join this party.</p>
      <img id="qrImg" class="qr" alt="Scan to join" />
      <button id="copyLinkBtn" class="btn-primary">${icons.copy}<span>Copy invite link</span></button>
    </div>
  </div>

  <div id="toasts" class="toasts"></div>
`;

const viz = new Visualizer($<HTMLCanvasElement>('#vizCanvas'));

// Restart the visualizer draw loop after returning from background (rAF pauses while hidden).
function resumeViz() {
  if (state.audioEl && !state.audioEl.paused) viz.start();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeViz();
});
window.addEventListener('pageshow', resumeViz);

// -----------------------------------------------------------------------------
// Landing: party list + host toggle + join
// -----------------------------------------------------------------------------
const enterBtn = $<HTMLButtonElement>('#enterBtn');

void loadParties();
async function loadParties() {
  try {
    const { parties } = await api.parties();
    const list = $('#partyList');
    list.innerHTML = parties
      .map(
        (p) =>
          `<button type="button" class="party-card" data-id="${p.id}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`
      )
      .join('');
    list.querySelectorAll<HTMLButtonElement>('.party-card').forEach((card) =>
      card.addEventListener('click', () => selectParty(card))
    );
    handleInviteLink(parties);
  } catch (err) {
    $('#partyList').innerHTML = `<p class="error">Couldn't load parties. Is the server configured?</p>`;
    console.error(err);
  }
}

function selectParty(card: HTMLButtonElement) {
  state.party = { id: card.dataset.id!, name: card.dataset.name! };
  $('#partyList')
    .querySelectorAll('.party-card')
    .forEach((c) => c.classList.toggle('on', c === card));
  refreshEnter();
}

$<HTMLInputElement>('#nameInput').addEventListener('input', refreshEnter);
$<HTMLInputElement>('#hostCheckbox').addEventListener('change', (e) => {
  $('#pwField').hidden = !(e.target as HTMLInputElement).checked;
  refreshEnter();
});
$<HTMLInputElement>('#pwInput').addEventListener('input', refreshEnter);

function refreshEnter() {
  const name = $<HTMLInputElement>('#nameInput').value.trim();
  const isHost = $<HTMLInputElement>('#hostCheckbox').checked;
  const pw = $<HTMLInputElement>('#pwInput').value;
  const ok = !!state.party && !!name && (!isHost || !!pw);
  enterBtn.disabled = !ok;
  enterBtn.textContent = !state.party
    ? 'Pick a party to continue'
    : !name
      ? 'Enter a nickname'
      : isHost
        ? 'Start hosting'
        : 'Join party';
}

enterBtn.addEventListener('click', () => {
  void join(
    $<HTMLInputElement>('#nameInput').value.trim(),
    $<HTMLInputElement>('#hostCheckbox').checked,
    $<HTMLInputElement>('#pwInput').value
  );
});

function handleInviteLink(parties: Party[]) {
  const params = new URLSearchParams(location.search);
  const partyId = params.get('party');
  if (!partyId) return;
  const party = parties.find((p) => p.id === partyId);
  if (!party) return;
  state.party = party;
  $('#partyList')
    .querySelectorAll<HTMLButtonElement>('.party-card')
    .forEach((c) => c.classList.toggle('on', c.dataset.id === partyId));
  const guest = params.get('name') || `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
  $<HTMLInputElement>('#nameInput').value = guest;
  history.replaceState(null, '', location.pathname);
  refreshEnter();
  void join(guest, false, ''); // scanned guests auto-join as listeners
}

// -----------------------------------------------------------------------------
// Join + connect (data-only LiveKit room)
// -----------------------------------------------------------------------------
async function join(name: string, isHost: boolean, password: string) {
  const err = $('#landingError');
  err.hidden = true;
  if (!state.party || !name) return;

  state.myName = name;
  state.isHost = isHost;
  state.hostPassword = password;
  enterBtn.disabled = true;
  enterBtn.textContent = 'Connecting…';

  try {
    const { token, url } = await api.token(state.party.id, name, isHost, password);
    await connect(url, token);
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : 'Failed to join.';
    err.hidden = false;
    refreshEnter();
  }
}

async function connect(url: string, token: string) {
  const room = new Room();
  state.room = room;

  const dot = $('#statusDot');
  room
    .on(RoomEvent.Connected, () => (dot.className = 'status connected'))
    .on(RoomEvent.Reconnecting, () => (dot.className = 'status reconnecting'))
    .on(RoomEvent.Reconnected, () => (dot.className = 'status connected'))
    .on(RoomEvent.Disconnected, () => (dot.className = 'status disconnected'));

  const updateMembers = () => {
    $('#memberCount').querySelector('b')!.textContent = String(room.remoteParticipants.size + 1);
  };
  room
    .on(RoomEvent.Connected, updateMembers)
    .on(RoomEvent.ParticipantConnected, updateMembers)
    .on(RoomEvent.ParticipantDisconnected, updateMembers);

  room.on(RoomEvent.DataReceived, onData);
  if (!state.isHost) {
    // When the host appears, (re)ask to join + learn its identity.
    room.on(RoomEvent.ParticipantConnected, () => {
      findHost();
      if (!state.admitted) send({ t: 'join-request', name: state.myName });
    });
    // NOTE: we deliberately do NOT end the party when the host disconnects — a host
    // backgrounding / brief network drop must not kick everyone. The party ends only
    // when the server schedule says so (ended: true).
  }

  await room.connect(url, token);

  // Shared audio element. Plain <audio> = background-friendly on every platform.
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous'; // R2 CORS-friendly fetch
  audioEl.preload = 'auto';
  // Keep pitch stable during the tiny rate nudges we use for correction.
  (audioEl as any).preservesPitch = true;
  (audioEl as any).webkitPreservesPitch = true;
  state.audioEl = audioEl;

  // Common header.
  $('#landing').hidden = true;
  $('#roomLabel').textContent = `#${state.party!.name}`;
  $('#roleBadge').textContent = state.isHost ? 'HOST' : 'LISTENER';
  $('#roleBadge').classList.toggle('host', state.isHost);
  document.body.classList.toggle('is-listener', !state.isHost);

  $<HTMLButtonElement>('#leaveBtn').addEventListener('click', leave);
  $<HTMLButtonElement>('#inviteBtn').addEventListener('click', openInvite);
  $<HTMLButtonElement>('#closeInviteBtn').addEventListener('click', () => ($('#inviteOverlay').hidden = true));
  $<HTMLButtonElement>('#copyLinkBtn').addEventListener('click', copyInviteLink);

  wireCommonAudio();
  startServerClock(); // sync to /api/time for everyone

  // Re-sync whenever we return from background — the robust recovery path.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void resync();
  });
  window.addEventListener('pageshow', () => void resync());

  if (state.isHost) {
    $('#player').hidden = false;
    await refreshPlaylist();
    await setupHost();
    setupMediaSession();
  } else {
    // Wait for the host's permission before entering.
    $('#waitingOverlay').hidden = false;
    $<HTMLButtonElement>('#cancelWaitBtn').addEventListener('click', leave);
    send({ t: 'join-request', name: state.myName });
  }
}

// Listener: enter the player once the host admits us.
async function admitListener(hostIdentity: string) {
  if (state.admitted) return;
  state.admitted = true;
  state.hostId = hostIdentity;
  $('#waitingOverlay').hidden = true;
  $('#player').hidden = false;
  await refreshPlaylist();
  setupListener();
  const got = await api.getSchedule(state.party!.id).catch(() => null);
  if (got) applySchedule(got.schedule);
  setupMediaSession();
  state.timers.push(window.setInterval(follow, FOLLOW_MS));
}

// -----------------------------------------------------------------------------
// Data channel
// -----------------------------------------------------------------------------
function send(msg: object, to?: string[]) {
  state.room?.localParticipant.publishData(enc.encode(JSON.stringify(msg)), {
    reliable: true,
    topic: CTRL,
    destinationIdentities: to
  });
}

function onData(payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) {
  if (topic !== CTRL || !participant) return;
  let m: any;
  try {
    m = JSON.parse(dec.decode(payload));
  } catch {
    return;
  }

  if (state.isHost) {
    if (m.t === 'join-request') {
      pendingJoins.set(participant.identity, m.name || participant.name || 'Guest');
      renderAdmitQueue();
    }
  } else {
    if (m.t === 'admit') void admitListener(participant.identity);
    else if (m.t === 'reject') {
      $('#waitTitle').textContent = 'Host declined';
      $('#waitMsg').textContent = "The host didn't let you in this time.";
      $('#waitSpinner').hidden = true;
      $<HTMLButtonElement>('#cancelWaitBtn').textContent = 'Close';
    } else if (!state.admitted) {
      return; // ignore until admitted
    } else if (m.t === 'schedule') {
      applySchedule(m.s as Schedule); // instant push of a schedule change
    }
  }
}

// --- Host: admit queue UI ---
function renderAdmitQueue() {
  const list = $('#admitList');
  if (pendingJoins.size === 0) {
    $('#admitOverlay').hidden = true;
    list.innerHTML = '';
    return;
  }
  list.innerHTML = [...pendingJoins.entries()]
    .map(
      ([id, name]) => `
      <li>
        <span class="admit-name">${escapeHtml(name)}</span>
        <span class="admit-actions">
          <button class="admit-yes" data-id="${id}">Allow</button>
          <button class="admit-no" data-id="${id}">Reject</button>
        </span>
      </li>`
    )
    .join('');
  list.querySelectorAll<HTMLButtonElement>('.admit-yes').forEach((b) =>
    b.addEventListener('click', () => respondJoin(b.dataset.id!, true))
  );
  list.querySelectorAll<HTMLButtonElement>('.admit-no').forEach((b) =>
    b.addEventListener('click', () => respondJoin(b.dataset.id!, false))
  );
  $('#admitOverlay').hidden = false;
}

function respondJoin(identity: string, allow: boolean) {
  const name = pendingJoins.get(identity) || 'Guest';
  pendingJoins.delete(identity);
  send({ t: allow ? 'admit' : 'reject' }, [identity]);
  // Push the current schedule straight to the new device (it also GETs it on admit).
  if (allow && state.schedule) setTimeout(() => send({ t: 'schedule', s: state.schedule }, [identity]), 300);
  toast(allow ? `✅ Let ${name} in` : `🚫 Rejected ${name}`);
  renderAdmitQueue();
}

// -----------------------------------------------------------------------------
// Playlist (shared)
// -----------------------------------------------------------------------------
async function refreshPlaylist() {
  if (!state.party) return;
  const prevKey = state.playlist[state.currentIndex]?.key;
  const { tracks } = await api.playlist(state.party.id);
  state.playlist = tracks;
  // Keep pointing at the same track across refreshes (URLs get re-presigned).
  if (prevKey) {
    const i = tracks.findIndex((t) => t.key === prevKey);
    if (i >= 0) state.currentIndex = i;
  }
  renderPlaylist();
}

function renderPlaylist() {
  const ul = $('#playlist');
  ul.innerHTML = state.playlist
    .map(
      (item, i) => `
      <li class="${i === state.currentIndex ? 'active' : ''}" data-i="${i}">
        <span class="pl-art">${i === state.currentIndex ? `<span class="pl-eq"><i></i><i></i><i></i></span>` : icons.note}</span>
        <span class="pl-text"><span class="pl-name">${escapeHtml(item.name)}</span></span>
        <span class="pl-idx">${i + 1}</span>
      </li>`
    )
    .join('');
  // Only the host can jump tracks by tapping the list.
  if (state.isHost) {
    ul.querySelectorAll<HTMLLIElement>('li').forEach((li) =>
      li.addEventListener('click', () => hostLoad(Number(li.dataset.i), !state.audioEl?.paused))
    );
  }
  $('#emptyHint').hidden = state.playlist.length > 0;
  $('#listCount').textContent = state.playlist.length ? `${state.playlist.length} songs` : '';
  if (state.isHost) updateTransportEnabled();
}

// -----------------------------------------------------------------------------
// Shared audio element lifecycle + visualizer
// -----------------------------------------------------------------------------
function wireCommonAudio() {
  const a = state.audioEl!;
  a.addEventListener('play', () => reflectPlayback(true));
  a.addEventListener('pause', () => reflectPlayback(false));
  a.addEventListener('timeupdate', updateProgress);
  a.addEventListener('loadedmetadata', updateProgress);
  a.addEventListener('error', () => {
    $('#playerArtist').textContent = `⚠ Couldn't play this track`;
  });
}

function reflectPlayback(playing: boolean) {
  $('#playPauseBtn').innerHTML = playing ? icons.pause : icons.play;
  $('#artwork').classList.toggle('playing', playing);
  if (playing) viz.start();
  else viz.stop();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function updateProgress() {
  const a = state.audioEl!;
  $('#totTime').textContent = fmt(a.duration);
  if (state.seeking) return;
  $('#curTime').textContent = fmt(a.currentTime);
  const pct = isFinite(a.duration) && a.duration > 0 ? (a.currentTime / a.duration) * 1000 : 0;
  const seek = $<HTMLInputElement>('#seekBar');
  seek.value = String(pct);
  seek.style.setProperty('--pct', `${pct / 10}%`);
}

function setMeta(track?: Track) {
  $('#playerTitle').textContent = track?.name ?? 'Nothing playing';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track?.name ?? 'Sync Music Player',
      artist: state.party?.name ?? 'SMP',
      album: 'Sync Music Player',
      artwork: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
  }
}

// -----------------------------------------------------------------------------
// HOST
// -----------------------------------------------------------------------------
async function setupHost() {
  $('#addMusicBtn').hidden = false;
  // Host doesn't "leave" — they "End" the party (which kicks everyone).
  $('#leaveBtn').querySelector('small')!.textContent = 'End';
  state.unlocked = true; // host's play tap is the gesture; it follows the timeline too
  $('#playerArtist').textContent = `${state.party!.name} · You are hosting`;

  const fileInput = $<HTMLInputElement>('#fileInput');
  $<HTMLButtonElement>('#addMusicBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => void uploadFiles(Array.from(fileInput.files ?? [])));

  $<HTMLButtonElement>('#playPauseBtn').addEventListener('click', () => {
    if (currentPlaying()) hostPause();
    else hostPlay();
  });
  $<HTMLButtonElement>('#nextBtn').addEventListener('click', () => hostNext());
  $<HTMLButtonElement>('#prevBtn').addEventListener('click', () => hostPrev());
  $<HTMLButtonElement>('#fwdBtn').addEventListener('click', () => hostSeekBy(SEEK_SECONDS));
  $<HTMLButtonElement>('#backBtn').addEventListener('click', () => hostSeekBy(-SEEK_SECONDS));

  const seek = $<HTMLInputElement>('#seekBar');
  seek.addEventListener('input', () => {
    state.seeking = true;
    const a = state.audioEl!;
    if (isFinite(a.duration)) $('#curTime').textContent = fmt((Number(seek.value) / 1000) * a.duration);
  });
  seek.addEventListener('change', () => {
    const a = state.audioEl!;
    state.seeking = false;
    if (isFinite(a.duration)) hostSeekTo((Number(seek.value) / 1000) * a.duration);
  });

  state.audioEl!.addEventListener('ended', () => hostNext());

  // Adopt an in-progress party if one exists (host took over / rejoined); else cue track 1.
  const got = await api.getSchedule(state.party!.id).catch(() => null);
  if (got && got.schedule.trackKey && !got.schedule.ended) {
    applySchedule(got.schedule);
  } else if (state.playlist.length) {
    setSchedule({ trackKey: state.playlist[0].key, anchorPos: 0, playing: false });
  }

  state.timers.push(window.setInterval(follow, FOLLOW_MS));
  updateTransportEnabled();
}

function currentKey(): string | null {
  return state.schedule?.trackKey ?? state.loadedKey ?? state.playlist[state.currentIndex]?.key ?? null;
}
function currentPlaying(): boolean {
  return !!state.schedule?.playing;
}

// ---------------------------------------------------------------------------
// The schedule = the single source of truth. Position is DERIVED, never pushed.
// ---------------------------------------------------------------------------

// HOST only: change the schedule. Persisted to the server + pushed for immediacy.
function setSchedule(p: { trackKey?: string | null; anchorPos?: number; playing?: boolean; ended?: boolean }) {
  const base: Schedule = state.schedule ?? {
    trackKey: null,
    anchorPos: 0,
    anchorServerTime: 0,
    playing: false,
    ended: false,
    rev: 0
  };
  const s: Schedule = {
    trackKey: p.trackKey !== undefined ? p.trackKey : base.trackKey,
    anchorPos: p.anchorPos !== undefined ? Math.max(0, Math.round(p.anchorPos)) : base.anchorPos, // whole seconds
    anchorServerTime: serverNow(),
    playing: p.playing !== undefined ? p.playing : base.playing,
    ended: p.ended !== undefined ? p.ended : base.ended,
    rev: base.rev + 1
  };
  state.schedule = s;
  applySchedule(s); // host follows its own schedule
  send({ t: 'schedule', s }); // instant push to listeners
  void api.putSchedule(state.party!.id, s, state.hostPassword).catch(() => {}); // persist
}

// BOTH: adopt a schedule (newer rev wins) and load its track.
function applySchedule(s: Schedule) {
  if (state.schedule && s.rev < state.schedule.rev) return; // ignore stale
  state.schedule = s;
  if (s.ended) {
    endedByHost();
    return;
  }
  if (s.trackKey && state.loadedKey !== s.trackKey) prepareTrack(s.trackKey);
  follow();
}

// Where the timeline says we should be, right now (derived from server clock).
function targetPos(s: Schedule): number {
  return s.playing ? s.anchorPos + (serverNow() - s.anchorServerTime) / 1000 : s.anchorPos;
}

// BOTH: the self-correction loop. Runs ~1/s; also called on any schedule change / resume.
//
// Design goals (to feel immersive, not jittery):
//   • DEAD-BAND: if we're within ~150ms, do NOTHING — devices just play, identical.
//   • HYSTERESIS: once we start nudging, keep nudging until we're back under ~60ms, so the
//     rate can't flip-flop around a threshold (that flip-flop WAS the audible wobble).
//   • Don't fight the OS: while backgrounded we skip correction entirely and re-sync on return.
//   • Don't start before ready: wait for buffering + a confident clock, so mid-join is clean.
const DEADBAND = 0.15; // s — within this, leave playback alone
const RESOLVED = 0.06; // s — stop nudging once back inside this
const HARD_SEEK = 1.5; // s — only a big gap warrants an audible seek

function follow() {
  const s = state.schedule;
  const a = state.audioEl;
  if (!s || !a) return;
  if (s.ended) return endedByHost();
  if (document.hidden) return; // OS is throttling us — don't issue bad seeks; resync on return
  if (!state.serverSynced || !state.unlocked) return;

  if (!s.trackKey) {
    if (!a.paused) a.pause();
    setStatus(false);
    return;
  }
  if (state.loadedKey !== s.trackKey) {
    prepareTrack(s.trackKey);
    return; // align next tick once it's loaded
  }
  if (!state.isHost && state.listenerPaused) return; // listener chose to pause locally

  if (!s.playing) {
    a.playbackRate = 1;
    state.correcting = false;
    if (Math.abs(a.currentTime - s.anchorPos) > 0.3) a.currentTime = Math.max(0, s.anchorPos);
    if (!a.paused) a.pause();
    setStatus(false);
    return;
  }

  const tgt = targetPos(s);

  // Start playback only once we have enough buffered — prevents the mid-join stall/struggle.
  if (a.paused) {
    if (a.readyState < 3) {
      setStatus(true, true); // "Buffering…"
      return;
    }
    a.currentTime = Math.max(0, tgt);
    a.play().catch(() => {});
  }

  // Don't correct while buffering or before the clock is trustworthy (avoids mid-join jitter).
  if (a.readyState < 2 || !state.clock.confident) {
    a.playbackRate = 1;
    setStatus(true);
    return;
  }

  const drift = a.currentTime - tgt; // +ve = ahead of the timeline
  const ad = Math.abs(drift);
  if (ad > HARD_SEEK) {
    a.currentTime = Math.max(0, tgt); // big gap → one corrective seek
    a.playbackRate = 1;
    state.correcting = false;
    state.driftStrikes = 0;
  } else {
    // DEBOUNCE: only act on drift that persists across checks, so a single noisy clock
    // reading (common on mobile Wi-Fi) never triggers a correction. This is what keeps
    // an already-synced device perfectly still.
    if (ad > DEADBAND) state.driftStrikes++;
    else state.driftStrikes = 0;
    if (state.driftStrikes >= 2) state.correcting = true;
    if (ad < RESOLVED) state.correcting = false;
    a.playbackRate = state.correcting ? (drift > 0 ? 0.985 : 1.015) : 1; // ~1.5%, inaudible
  }
  setStatus(true);
}

function setStatus(playing: boolean, buffering = false) {
  if (state.isHost) return; // host shows the "hosting" line
  $('#playerArtist').textContent = buffering ? '⏳ Buffering…' : playing ? '🔴 In sync — live' : '⏸ Host paused';
}

// Load a track into the audio element (idempotent per key).
function prepareTrack(key: string) {
  if (key === state.loadedKey) return;
  const idx = state.playlist.findIndex((t) => t.key === key);
  if (idx < 0) {
    void refreshPlaylist();
    return;
  }
  state.currentIndex = idx;
  const a = state.audioEl!;
  a.src = state.playlist[idx].url;
  a.load();
  state.loadedKey = key;
  setMeta(state.playlist[idx]);
  if (state.isHost) $('#playerArtist').textContent = `${state.party!.name} · You are hosting`;
  renderPlaylist();
}

// ---- Host transport: every control just updates the schedule ----
function hostPlay() {
  if (!currentKey() && state.playlist.length) prepareTrack(state.playlist[0].key);
  const pos = state.schedule ? targetPos(state.schedule) : state.audioEl!.currentTime;
  setSchedule({ trackKey: currentKey(), anchorPos: pos, playing: true });
}
function hostPause() {
  const pos = state.schedule && state.schedule.playing ? targetPos(state.schedule) : state.audioEl!.currentTime;
  setSchedule({ anchorPos: pos, playing: false });
}
function hostSeekTo(pos: number) {
  setSchedule({ anchorPos: pos, playing: currentPlaying() });
}
function hostSeekBy(s: number) {
  const a = state.audioEl!;
  const from = state.schedule ? targetPos(state.schedule) : a.currentTime;
  const dur = isFinite(a.duration) ? a.duration : from + s;
  hostSeekTo(Math.max(0, Math.min(dur, from + s)));
}
function hostLoad(index: number, play: boolean) {
  if (index < 0 || index >= state.playlist.length) return;
  setSchedule({ trackKey: state.playlist[index].key, anchorPos: 0, playing: play });
}
function hostNext() {
  if (state.currentIndex < state.playlist.length - 1) hostLoad(state.currentIndex + 1, true);
  else hostPause();
}
function hostPrev() {
  const a = state.audioEl!;
  const playing = currentPlaying();
  if ((a.currentTime > 3 || state.currentIndex <= 0)) hostSeekTo(0);
  else hostLoad(state.currentIndex - 1, playing);
}
function updateTransportEnabled() {
  const has = state.playlist.length > 0;
  for (const id of ['playPauseBtn', 'fwdBtn', 'backBtn', 'prevBtn']) {
    $<HTMLButtonElement>(`#${id}`).disabled = !has;
  }
  $<HTMLButtonElement>('#nextBtn').disabled = !has || state.currentIndex >= state.playlist.length - 1;
}

// ---- Server clock + recovery ----
function serverNow() {
  return state.clock.hostNow(); // SyncClock offset is measured against /api/time
}
async function pingServerTime() {
  const t0 = Date.now();
  try {
    const { now } = await api.time();
    state.clock.sample(t0, now, Date.now());
    state.serverSynced = true;
    $('#syncDot').hidden = true;
  } catch {
    /* keep last estimate */
  }
}
function startServerClock() {
  let n = 0;
  void pingServerTime();
  // Fast initial burst so the clock is confident within ~1s → clean mid-join, no lurch.
  const fast = window.setInterval(async () => {
    await pingServerTime();
    if (++n >= 8) clearInterval(fast);
  }, 300);
  state.timers.push(fast);
  state.timers.push(window.setInterval(pingServerTime, 15000)); // track clock drift
}

// Re-sync after returning from background, on resume, etc.
async function resync() {
  await pingServerTime();
  if (!state.isHost && state.admitted) {
    const got = await api.getSchedule(state.party!.id).catch(() => null);
    if (got) applySchedule(got.schedule);
  }
  follow();
}

const MAX_SONGS_PER_PARTY = 100;

async function uploadFiles(files: File[]) {
  const fileInput = $<HTMLInputElement>('#fileInput');
  fileInput.value = '';
  if (!files.length) return;

  let added = false;
  for (const file of files) {
    if (state.playlist.length >= MAX_SONGS_PER_PARTY) {
      toast(`⚠ Party is full (${MAX_SONGS_PER_PARTY} songs max)`);
      break;
    }
    try {
      const type = file.type || 'audio/mpeg';
      toast(`⬆ Uploading “${file.name}”…`);
      const { url } = await api.uploadUrl(state.party!.id, file.name, type, file.size, state.hostPassword);
      const put = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': type } });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      toast(`✅ Added “${file.name}”`);
      added = true;
      await refreshPlaylist(); // keep the count current for the cap check above
    } catch (e) {
      // Show the server's reason (file too large / party full / storage full / wrong password).
      toast(`⚠ ${e instanceof Error ? e.message : 'Upload failed'}`);
    }
  }
  if (added) {
    // Listeners refetch the playlist on demand (when the schedule points at a track they
    // don't have yet), so no broadcast is needed. Just cue track 1 if nothing's set.
    if (!state.schedule?.trackKey && state.playlist.length) {
      setSchedule({ trackKey: state.playlist[0].key, anchorPos: 0, playing: false });
    }
  }
}

// -----------------------------------------------------------------------------
// LISTENER
// -----------------------------------------------------------------------------
function setupListener() {
  // Listener gets a clean player: no playlist, no host transport — just play/pause.
  $('#content').hidden = true;
  $('#progressRow').classList.add('readonly');
  $<HTMLInputElement>('#seekBar').disabled = true;
  for (const id of ['prevBtn', 'backBtn', 'fwdBtn', 'nextBtn']) $(`#${id}`).hidden = true;
  $('#playerArtist').textContent = 'Connecting to the host…';

  $<HTMLButtonElement>('#playPauseBtn').addEventListener('click', () => {
    const a = state.audioEl!;
    if (a.paused) {
      state.listenerPaused = false;
      state.unlocked = true;
      void resync(); // re-read schedule + server clock, then follow
    } else {
      state.listenerPaused = true; // stays paused until they tap play
      a.pause();
    }
  });

  // First gesture: unlock audio, then sync to the timeline.
  $('#unmuteOverlay').hidden = false;
  $<HTMLButtonElement>('#unmuteBtn').addEventListener('click', () => {
    state.unlocked = true;
    state.listenerPaused = false;
    $('#unmuteOverlay').hidden = true;
    void resync();
  });

  $('#syncDot').hidden = false;
}

function findHost() {
  if (state.hostId || !state.room) return;
  for (const p of state.room.remoteParticipants.values()) {
    try {
      if (JSON.parse(p.metadata || '{}').role === 'host') {
        state.hostId = p.identity;
        break;
      }
    } catch {
      /* ignore */
    }
  }
}

// -----------------------------------------------------------------------------
// Media Session (lock-screen controls + background)
// -----------------------------------------------------------------------------
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const a = state.audioEl!;
  const handlers: Partial<Record<MediaSessionAction, () => void>> = state.isHost
    ? {
        play: () => hostPlay(),
        pause: () => hostPause(),
        nexttrack: () => hostNext(),
        previoustrack: () => hostPrev(),
        seekforward: () => hostSeekBy(SEEK_SECONDS),
        seekbackward: () => hostSeekBy(-SEEK_SECONDS)
      }
    : {
        play: () => {
          state.listenerPaused = false;
          state.unlocked = true;
          void resync();
        },
        pause: () => {
          state.listenerPaused = true;
          a.pause();
        }
      };
  for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekforward', 'seekbackward'] as const) {
    try {
      navigator.mediaSession.setActionHandler(action, handlers[action] ?? null);
    } catch {
      /* unsupported */
    }
  }
}

// -----------------------------------------------------------------------------
// Invite by QR
// -----------------------------------------------------------------------------
const inviteUrl = () => `${location.origin}/?party=${encodeURIComponent(state.party!.id)}`;
async function openInvite() {
  const dataUrl = await QRCode.toDataURL(inviteUrl(), {
    width: 320,
    margin: 1,
    color: { dark: '#0c0a14', light: '#ffffff' }
  });
  $<HTMLImageElement>('#qrImg').src = dataUrl;
  $('#inviteOverlay').hidden = false;
}
async function copyInviteLink() {
  const span = $<HTMLButtonElement>('#copyLinkBtn').querySelector('span')!;
  try {
    await navigator.clipboard.writeText(inviteUrl());
    span.textContent = 'Copied! ✓';
  } catch {
    span.textContent = inviteUrl();
  }
  setTimeout(() => (span.textContent = 'Copy invite link'), 2000);
}

// -----------------------------------------------------------------------------
// Leave + utils
// -----------------------------------------------------------------------------
async function leave() {
  // Host "ends" the party — mark the schedule ended (persisted + pushed) so EVERY device
  // leaves, even ones currently backgrounded that re-read the schedule on resume.
  if (state.isHost && state.room) {
    setSchedule({ ended: true });
    await new Promise((r) => setTimeout(r, 300)); // let the push + persist flush
  }
  state.timers.forEach((t) => clearInterval(t));
  try {
    await state.room?.disconnect();
  } finally {
    state.audioEl?.pause();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    }
    location.reload();
  }
}

// Listener: the host ended the party (explicit message OR host disconnected).
function endedByHost() {
  if (state.isHost || state.ended) return;
  state.ended = true;
  state.timers.forEach((t) => clearInterval(t));
  state.audioEl?.pause();
  state.room?.disconnect().catch(() => {});

  $('#player').hidden = true;
  $('#inviteOverlay').hidden = true;
  $('#unmuteOverlay').hidden = true;
  $('#waitTitle').textContent = 'Party ended';
  $('#waitMsg').textContent = 'The host ended the party.';
  $('#waitSpinner').hidden = true;
  $<HTMLButtonElement>('#cancelWaitBtn').textContent = 'Back to start';
  $('#waitingOverlay').hidden = false;
  setTimeout(() => location.reload(), 2500);
}

function fmt(sec: number) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function escapeHtml(str: string) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
function toast(text: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}
