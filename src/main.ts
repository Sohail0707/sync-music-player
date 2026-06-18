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
//  • EVENT-DRIVEN, not a loop: each action becomes a schedule that executes a moment in the
//    future; every device (host included) does ONE apply at that instant, then plays
//    untouched. Re-sync happens only on join, action, resume, or a buffer stall — so there's
//    no constant correction to cause jitter. Only the host may CHANGE the schedule.
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
const SAME_LEAD = 700; // ms — actions execute this far in the future, so ALL devices fire together
const TRACK_LEAD = 1500; // ms — track change: extra time to buffer the new file
const CLOCK_REFRESH_MS = 30000; // occasional clock re-sync (does NOT touch audio)
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
  audioCtx: AudioContext | null; // visualizer only (non-iOS)
  graphReady: boolean;
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
  applyTimer: number; // pending one-shot "execute this action at T" timer
  lastClockSync: number; // Date.now() of last server-time ping
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
  audioCtx: null,
  graphReady: false,
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
  applyTimer: 0,
  lastClockSync: 0,
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

// Restart the visualizer after returning from background (rAF pauses while hidden, and the
// AudioContext can be left suspended — resume it so the analyser + audio recover).
function resumeViz() {
  state.audioCtx?.resume?.().catch(() => {});
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

  // CRITICAL (mobile autoplay): create + unlock the audio element NOW, inside the click
  // gesture (before any await). Once an element has played via a gesture, iOS/Android let
  // us play it programmatically later — so we never need a "tap to start" popup.
  unlockAudio();

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

// Build the audio element and bless it within the user gesture (plays a tiny silent clip).
function unlockAudio() {
  if (state.audioEl) return;
  const a = new Audio();
  a.crossOrigin = 'anonymous'; // R2 CORS-friendly fetch
  a.preload = 'auto';
  (a as any).playsInline = true;
  state.audioEl = a;
  state.unlocked = true;

  // Tiny silent WAV so the very first play() happens during the gesture.
  try {
    a.src = silentWavUrl();
    a.muted = true;
    a.play()
      .then(() => {
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      })
      .catch(() => {
        a.muted = false;
      });
  } catch {
    /* ignore */
  }

  // Analyser graph for REAL reactive bars (all platforms, inside the gesture). The audio
  // stays audible (routed to destination). If this fails or yields no data, the visualizer
  // gracefully shows its animation instead.
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    state.audioCtx = ctx;
    void ctx.resume().catch(() => {});
    const src = ctx.createMediaElementSource(a);
    const analyser = ctx.createAnalyser();
    src.connect(analyser);
    src.connect(ctx.destination);
    viz.connect(analyser);
    state.graphReady = true;
  } catch (e) {
    console.warn('Reactive visualizer unavailable:', e);
  }
}

function silentWavUrl() {
  const sr = 8000;
  const n = Math.floor(sr * 0.2);
  const buf = new ArrayBuffer(44 + n);
  const dv = new DataView(buf);
  const wr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  wr(0, 'RIFF');
  dv.setUint32(4, 36 + n, true);
  wr(8, 'WAVE');
  wr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  wr(36, 'data');
  dv.setUint32(40, n, true);
  for (let i = 0; i < n; i++) dv.setUint8(44 + i, 128); // 8-bit silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
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

  // (audioEl was created + unlocked in join(), within the user gesture.)

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

// Listener: enter the player once the host admits us. No "tap to sync" popup — we already
// unlocked audio on the join gesture, so we just apply the timeline and play.
async function admitListener(hostIdentity: string) {
  if (state.admitted) return;
  state.admitted = true;
  state.hostId = hostIdentity;
  $('#waitingOverlay').hidden = true;
  $('#player').hidden = false;
  await refreshPlaylist();
  setupListener();
  setupMediaSession();
  await resync(); // fetch the schedule + clock, then apply once → instantly in sync
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
      onSchedule(m.s as Schedule); // instant push of an action → execute it once, together
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
  // Recover from a buffer interruption: when it resumes after stalling, re-sync to live ONCE.
  let stalled = false;
  a.addEventListener('waiting', () => (stalled = true));
  a.addEventListener('playing', () => {
    if (stalled) {
      stalled = false;
      void resync();
    }
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
    onSchedule(got.schedule);
  } else if (state.playlist.length) {
    setSchedule({ trackKey: state.playlist[0].key, anchorPos: 0, playing: false });
  }

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

// ---------------------------------------------------------------------------
// EVENT-DRIVEN sync. There is NO continuous correction loop. Each action becomes a
// schedule whose anchorServerTime is a moment in the NEAR FUTURE; every device — host
// included — schedules a SINGLE apply at that absolute instant, so they all fire together.
// Between actions, devices just play untouched (same file, same speed → stay in sync).
// ---------------------------------------------------------------------------

// HOST only: issue an action. Builds a schedule that executes `lead` ms from now.
function setSchedule(
  p: { trackKey?: string | null; anchorPos?: number; playing?: boolean; ended?: boolean },
  lead = SAME_LEAD
) {
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
    anchorServerTime: serverNow() + lead, // execute together, slightly in the future
    playing: p.playing !== undefined ? p.playing : base.playing,
    ended: p.ended !== undefined ? p.ended : base.ended,
    rev: base.rev + 1
  };
  state.schedule = s;
  send({ t: 'schedule', s }); // distribute to everyone
  void api.putSchedule(state.party!.id, s, state.hostPassword).catch(() => {}); // persist for recovery/late-join
  onSchedule(s, true); // the host obeys the same schedule (no direct action)
}

// BOTH: adopt a schedule and schedule ONE apply at its execution time.
function onSchedule(s: Schedule, fromSelf = false) {
  if (state.schedule && !fromSelf && s.rev < state.schedule.rev) return; // ignore stale
  state.schedule = s;
  if (s.ended) return endedByHost();
  if (s.trackKey) prepareTrack(s.trackKey); // start buffering now
  if (state.applyTimer) clearTimeout(state.applyTimer);
  if (!state.unlocked) return; // will apply after the unlock gesture (resync)

  const delay = s.anchorServerTime - serverNow();
  if (delay > 30) state.applyTimer = window.setTimeout(() => applyOnce(s), delay);
  else applyOnce(s); // already due (late join / recovery) → seek to live now
}

// BOTH: execute a schedule exactly once. No loops, no nudging.
function applyOnce(s: Schedule) {
  const a = state.audioEl;
  if (!a || !state.schedule || s.rev < state.schedule.rev) return;
  if (!s.trackKey) {
    if (!a.paused) a.pause();
    setStatus(false);
    return;
  }
  if (!state.isHost && state.listenerPaused) return; // listener chose to stay paused
  if (state.loadedKey !== s.trackKey) prepareTrack(s.trackKey);

  const elapsed = Math.max(0, (serverNow() - s.anchorServerTime) / 1000);
  const target = s.playing ? s.anchorPos + elapsed : s.anchorPos;
  const go = () => {
    if (Math.abs(a.currentTime - target) > 0.15) a.currentTime = Math.max(0, target);
    if (s.playing) a.play().catch(() => {});
    else a.pause();
    setStatus(s.playing);
  };
  if (a.readyState >= 1) go();
  else a.addEventListener('loadedmetadata', go, { once: true });
}

// Live timeline position (derived from the server clock) — used by the host to anchor actions.
function timelinePos(): number {
  const s = state.schedule;
  if (!s || !s.trackKey) return 0;
  return s.playing ? s.anchorPos + (serverNow() - s.anchorServerTime) / 1000 : s.anchorPos;
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

// ---- Host transport: every control just issues a scheduled action ----
function hostPlay() {
  if (!currentKey() && state.playlist.length) prepareTrack(state.playlist[0].key);
  setSchedule({ trackKey: currentKey(), anchorPos: timelinePos(), playing: true });
}
function hostPause() {
  // Project to the execution instant so everyone (incl. host) pauses at the same second.
  setSchedule({ anchorPos: timelinePos() + SAME_LEAD / 1000, playing: false });
}
function hostSeekTo(pos: number) {
  setSchedule({ anchorPos: pos, playing: currentPlaying() });
}
function hostSeekBy(s: number) {
  const a = state.audioEl!;
  const from = timelinePos();
  const dur = isFinite(a.duration) ? a.duration : from + s;
  hostSeekTo(Math.max(0, Math.min(dur, from + s)));
}
function hostLoad(index: number, play: boolean) {
  if (index < 0 || index >= state.playlist.length) return;
  // Track change needs extra lead so every device can buffer the new file first.
  setSchedule({ trackKey: state.playlist[index].key, anchorPos: 0, playing: play }, TRACK_LEAD);
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
    state.lastClockSync = Date.now();
    $('#syncDot').hidden = true;
  } catch {
    /* keep last estimate */
  }
}
function startServerClock() {
  let n = 0;
  void pingServerTime();
  // Fast initial burst so the clock is confident within ~1s → clean join, accurate actions.
  const fast = window.setInterval(async () => {
    await pingServerTime();
    if (++n >= 8) clearInterval(fast);
  }, 300);
  state.timers.push(fast);
  // Occasional refresh only (NOT a correction loop) — tracks slow clock drift. This never
  // touches the audio, so it can't cause jitter.
  state.timers.push(window.setInterval(pingServerTime, CLOCK_REFRESH_MS));
}
async function ensureFreshClock() {
  if (Date.now() - state.lastClockSync > 8000) await pingServerTime();
}

// Recovery path: on join, on returning from background, and after a stall. Refreshes the
// clock + (for listeners) re-reads the schedule, then applies ONCE — no ongoing loop.
async function resync() {
  if (state.ended) return;
  await ensureFreshClock();
  if (!state.isHost && state.admitted) {
    const got = await api.getSchedule(state.party!.id).catch(() => null);
    if (got) {
      onSchedule(got.schedule);
      return;
    }
  }
  if (state.schedule) applyOnce(state.schedule);
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
      void resync(); // re-read schedule + clock, then apply once → back in sync
    } else {
      state.listenerPaused = true; // stays paused until they tap play
      a.pause();
    }
  });

  // No "tap to sync" popup — audio was already unlocked on the join gesture, so admitListener
  // applies the timeline automatically.
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
