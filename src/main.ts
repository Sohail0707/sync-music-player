// src/main.ts
// -----------------------------------------------------------------------------
// Sync Music Player (SMP) — "Serverless DJ" / synced local playback.
//
//  Architecture (no live audio streaming):
//    • Songs live in Cloudflare R2; everyone DOWNLOADS and plays their own local copy.
//    • LiveKit carries only tiny control messages (clock sync + transport state).
//    • Host controls the timeline; listeners follow, clock-synced with drift correction.
//
//  Why this design: playing through a normal <audio> element (not Web Audio capture)
//  means iPhone can host, background playback works, and there's ~no playback latency —
//  the problems the live-streaming version couldn't solve on iOS.
// -----------------------------------------------------------------------------

import { Room, RoomEvent, type RemoteParticipant } from 'livekit-client';
import QRCode from 'qrcode';

import { api, type Party, type Track } from './api';
import { SyncClock } from './sync';
import { icons } from './icons';
import { Visualizer } from './visualizer';
import './style.css';

const CTRL = 'smp-ctrl';
const SEEK_SECONDS = 10;
const enc = new TextEncoder();
const dec = new TextDecoder();

// iPadOS reports as MacIntel + touch. On iOS we must NOT route audio through Web Audio
// (it would suspend in the background), so the real analyser visualizer is desktop/Android
// only; iOS gets a CSS pulse instead — keeping background playback intact.
const isIOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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
  audioCtx: AudioContext | null;
  graphReady: boolean;
  playlist: Track[];
  currentIndex: number;
  seeking: boolean;
  clock: SyncClock;
  hostId: string | null; // listener's view of the host participant
  unlocked: boolean; // listener has tapped to allow audio
  listenerPaused: boolean; // listener manually paused — don't auto-resume
  admitted: boolean; // listener has been let in by the host
  ended: boolean; // party ended by host
  loadedKey: string | null; // track key currently loaded into the audio element
  cmdTimer: number; // pending scheduled-command timeout id
  lastCmd: Cmd | null; // most recent scheduled command
  timers: number[];
}

// A scheduled transport command: "be at <pos> of <key>, <playing>, exactly at host-time <at>".
interface Cmd {
  t: 'cmd';
  key: string | null;
  pos: number;
  playing: boolean;
  at: number; // host clock (Date.now) at which EVERY device executes
}
// Lead times: how far in the future to schedule, so the message reaches everyone first.
const SAME_TRACK_LEAD = 400; // ms — play / pause / seek within the loaded track
const NEW_TRACK_LEAD = 1200; // ms — switching tracks: extra time to buffer the new file

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
  hostId: null,
  unlocked: false,
  listenerPaused: false,
  admitted: false,
  ended: false,
  loadedKey: null,
  cmdTimer: 0,
  lastCmd: null,
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

// Resume the (visualizer) AudioContext + draw loop after returning from background.
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
    // When the host appears, (re)ask to join + learn its identity for clock pings.
    room.on(RoomEvent.ParticipantConnected, () => {
      findHost();
      if (!state.admitted) send({ t: 'join-request', name: state.myName });
    });
    // Fallback: if the host's connection drops without an explicit "ended" message,
    // treat it as the party ending.
    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      let wasHost = p.identity === state.hostId;
      try {
        wasHost = wasHost || JSON.parse(p.metadata || '{}').role === 'host';
      } catch {
        /* ignore */
      }
      if (wasHost) endedByHost();
    });
  }

  await room.connect(url, token);

  // Shared audio element. Plain <audio> = background-friendly on every platform.
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous'; // needed for R2 CORS + Web Audio analyser
  audioEl.preload = 'auto';
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

  if (state.isHost) {
    $('#player').hidden = false;
    await refreshPlaylist();
    setupHost();
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
  setupMediaSession();
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
    // Host handles join requests, clock pings, and state requests.
    if (m.t === 'join-request') {
      pendingJoins.set(participant.identity, m.name || participant.name || 'Guest');
      renderAdmitQueue();
    } else if (m.t === 'clock-ping') {
      send({ t: 'clock-pong', id: m.id, c0: m.c0, h: Date.now() }, [participant.identity]);
    } else if (m.t === 'hello') {
      // A device (re)joined and asked for the current point — re-sync EVERYONE to a
      // shared whole-second boundary so the new device lands exactly in place.
      broadcastSync();
    }
  } else {
    if (m.t === 'ended') endedByHost();
    else if (m.t === 'admit') void admitListener(participant.identity);
    else if (m.t === 'reject') {
      $('#waitTitle').textContent = 'Host declined';
      $('#waitMsg').textContent = "The host didn't let you in this time.";
      $('#waitSpinner').hidden = true;
      $<HTMLButtonElement>('#cancelWaitBtn').textContent = 'Close';
    } else if (!state.admitted) {
      return; // ignore everything else until admitted
    } else if (m.t === 'cmd') {
      // Absolute scheduled transition — run it at the same instant as everyone else.
      if (state.unlocked) applyScheduled(m as Cmd);
      else state.lastCmd = m as Cmd;
    } else if (m.t === 'clock-pong') {
      state.clock.sample(m.c0, m.h, Date.now());
      $('#syncDot').hidden = true;
    } else if (m.t === 'playlist') {
      void refreshPlaylist().then(() => {
        if (state.lastCmd) applyScheduled(state.lastCmd);
      });
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
  // Re-sync the whole room to a shared whole-second boundary so the new device fits in.
  if (allow) setTimeout(() => broadcastSync(), 400);
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

// Lazily build the analyser graph for the visualizer — DESKTOP/ANDROID ONLY.
// On iOS we deliberately skip this so audio keeps playing in the background.
function ensureGraph() {
  state.audioCtx?.resume?.().catch(() => {});
  if (isIOS || state.graphReady) return;
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    state.audioCtx = ctx;
    const src = ctx.createMediaElementSource(state.audioEl!);
    const analyser = ctx.createAnalyser();
    src.connect(analyser);
    src.connect(ctx.destination); // keep it audible
    viz.connect(analyser);
    state.graphReady = true;
  } catch (e) {
    console.warn('Visualizer graph unavailable:', e);
  }
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
function setupHost() {
  $('#addMusicBtn').hidden = false;
  // Host doesn't "leave" — they "End" the party (which kicks everyone).
  $('#leaveBtn').querySelector('small')!.textContent = 'End';
  $('#playerArtist').textContent = `${state.party!.name} · You are hosting`;

  const fileInput = $<HTMLInputElement>('#fileInput');
  $<HTMLButtonElement>('#addMusicBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => void uploadFiles(Array.from(fileInput.files ?? [])));

  $<HTMLButtonElement>('#playPauseBtn').addEventListener('click', () => {
    if (state.audioEl!.paused) hostPlay();
    else hostPause();
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
    if (isFinite(a.duration)) scheduleCommand(currentKey(), (Number(seek.value) / 1000) * a.duration, !a.paused);
  });

  // Periodic absolute re-sync: every few seconds, snap everyone (host included) to the
  // next whole-second boundary. Keeps all devices locked without per-device fudging.
  state.audioEl!.addEventListener('ended', () => hostNext());
  state.timers.push(window.setInterval(() => broadcastSync(), 4000));

  // Cue the first track (loaded, paused) so the host can just press play.
  if (!currentKey() && state.playlist.length) prepareTrack(state.playlist[0].key);
  updateTransportEnabled();
}

function currentKey(): string | null {
  return state.loadedKey ?? state.playlist[state.currentIndex]?.key ?? null;
}

// ---------------------------------------------------------------------------
// Absolute scheduled-command engine (shared by host + listeners)
//
// The host NEVER acts immediately. It schedules a transition for an ABSOLUTE host-
// clock instant `at`, with a WHOLE-SECOND position `pos`. Every device — including
// the host — converts `at` to its own clock and runs it then. So all devices land on
// the exact same second at the exact same moment; nobody starts early.
// ---------------------------------------------------------------------------

// Send a command to everyone AND schedule it locally — host obeys its own schedule.
function emitCmd(cmd: Cmd) {
  send(cmd);
  applyScheduled(cmd);
}

// HOST: a discrete action (play / pause / seek / track). Position snaps to a whole second.
function scheduleCommand(key: string | null, pos: number, playing: boolean) {
  const newTrack = !!key && key !== state.loadedKey;
  emitCmd({
    t: 'cmd',
    key,
    pos: Math.max(0, Math.round(pos)), // absolute whole seconds, never fractional
    playing,
    at: Date.now() + (newTrack ? NEW_TRACK_LEAD : SAME_TRACK_LEAD)
  });
}

// HOST: periodic / on-join re-sync. Targets the next whole-second the host will reach,
// timed so the host itself doesn't jump and every listener snaps to that exact second.
function broadcastSync() {
  if (!state.isHost) return;
  const a = state.audioEl!;
  const key = currentKey();
  if (!key) {
    emitCmd({ t: 'cmd', key: null, pos: 0, playing: false, at: Date.now() + 200 });
    return;
  }
  if (a.paused) {
    emitCmd({ t: 'cmd', key, pos: Math.max(0, Math.round(a.currentTime)), playing: false, at: Date.now() + SAME_TRACK_LEAD });
    return;
  }
  const pos = Math.ceil(a.currentTime + 1); // next whole second, ≥1s ahead
  const at = Date.now() + Math.round((pos - a.currentTime) * 1000); // exact moment host hits `pos`
  emitCmd({ t: 'cmd', key, pos, playing: true, at });
}

// BOTH: buffer the track now, then run the action exactly at cmd.at.
function applyScheduled(cmd: Cmd) {
  if (state.cmdTimer) clearTimeout(state.cmdTimer);
  state.lastCmd = cmd;
  if (cmd.key) prepareTrack(cmd.key); // start buffering during the lead window
  const fireLocal = cmd.at - state.clock.offset; // host offset = 0; listeners use their estimate
  state.cmdTimer = window.setTimeout(() => runCmd(cmd), Math.max(0, fireLocal - Date.now()));
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

function runCmd(cmd: Cmd) {
  const a = state.audioEl!;
  state.cmdTimer = 0;
  if (!cmd.key) {
    a.pause();
    if (!state.isHost) $('#playerArtist').textContent = 'Host hasn’t started yet…';
    return;
  }
  if (state.loadedKey !== cmd.key) prepareTrack(cmd.key);
  const shouldPlay = cmd.playing && !(!state.isHost && state.listenerPaused);
  const go = () => {
    // Seek only when meaningfully off, so periodic re-syncs are silent when already aligned.
    if (Math.abs(a.currentTime - cmd.pos) > 0.15) a.currentTime = Math.max(0, cmd.pos);
    if (shouldPlay) a.play().catch(() => {});
    else a.pause();
    if (!state.isHost) $('#playerArtist').textContent = cmd.playing ? '🔴 In sync — live' : '⏸ Host paused';
  };
  if (a.readyState >= 1) go();
  else a.addEventListener('loadedmetadata', go, { once: true });
}

// ---- Host transport: every control schedules a command ----
function hostPlay() {
  ensureGraph(); // gesture path — safe to set up Web Audio here
  if (!currentKey() && state.playlist.length) prepareTrack(state.playlist[0].key);
  scheduleCommand(currentKey(), state.audioEl!.currentTime, true);
}
function hostPause() {
  // Pause everyone at the position the host WILL be at by `at` (projected forward).
  scheduleCommand(currentKey(), state.audioEl!.currentTime + SAME_TRACK_LEAD / 1000, false);
}
function hostLoad(index: number, play: boolean) {
  if (index < 0 || index >= state.playlist.length) return;
  scheduleCommand(state.playlist[index].key, 0, play);
}
function hostNext() {
  if (state.currentIndex < state.playlist.length - 1) hostLoad(state.currentIndex + 1, true);
  else hostPause();
}
function hostPrev() {
  const a = state.audioEl!;
  const playing = !a.paused;
  if (a.currentTime > 3 || state.currentIndex <= 0) scheduleCommand(currentKey(), 0, playing);
  else hostLoad(state.currentIndex - 1, playing);
}
function hostSeekBy(s: number) {
  const a = state.audioEl!;
  if (!isFinite(a.duration)) return;
  scheduleCommand(currentKey(), Math.max(0, Math.min(a.duration, a.currentTime + s)), !a.paused);
}
function updateTransportEnabled() {
  const has = state.playlist.length > 0;
  for (const id of ['playPauseBtn', 'fwdBtn', 'backBtn', 'prevBtn']) {
    $<HTMLButtonElement>(`#${id}`).disabled = !has;
  }
  $<HTMLButtonElement>('#nextBtn').disabled = !has || state.currentIndex >= state.playlist.length - 1;
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
    send({ t: 'playlist' }); // tell listeners to refetch
    if (!currentKey() && state.playlist.length) prepareTrack(state.playlist[0].key);
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
      askResync();
    } else {
      state.listenerPaused = true; // stays paused; re-sync won't auto-resume
      a.pause();
    }
  });

  // First gesture: unlock audio, then ask the host to re-sync everyone.
  $('#unmuteOverlay').hidden = false;
  $<HTMLButtonElement>('#unmuteBtn').addEventListener('click', () => {
    state.unlocked = true;
    state.listenerPaused = false;
    ensureGraph();
    $('#unmuteOverlay').hidden = true;
    askResync();
  });

  $('#syncDot').hidden = false;
  startClockSync();
}

// Ask the host for a fresh whole-second sync (host re-syncs everyone), and apply the
// last known command immediately so there's no dead air while we wait.
function askResync() {
  findHost();
  send({ t: 'hello', name: state.myName });
  if (state.lastCmd) applyScheduled(state.lastCmd);
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

function startClockSync() {
  let burst = 0;
  const ping = () => {
    findHost();
    if (state.hostId) send({ t: 'clock-ping', id: Math.random(), c0: Date.now() }, [state.hostId]);
  };
  // 8 quick pings to lock on, then every 12s to track drift.
  const fast = window.setInterval(() => {
    ping();
    if (++burst >= 8) clearInterval(fast);
  }, 600);
  state.timers.push(fast);
  state.timers.push(window.setInterval(ping, 12000));
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
          askResync();
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
  // Host "ends" the party — tell everyone before disconnecting so they auto-leave.
  if (state.isHost && state.room) {
    send({ t: 'ended' });
    await new Promise((r) => setTimeout(r, 250)); // let the reliable message flush
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
