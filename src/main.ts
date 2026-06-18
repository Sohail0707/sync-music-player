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
import { SyncClock, type SyncState } from './sync';
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
  lastState: SyncState | null; // last transport state the listener received
  unlocked: boolean; // listener has tapped to allow audio
  timers: number[];
}
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
  lastState: null,
  unlocked: false,
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
    // Discover the host (for clock-ping targeting) as participants appear.
    room.on(RoomEvent.ParticipantConnected, () => findHost());
  }

  await room.connect(url, token);

  // Shared audio element. Plain <audio> = background-friendly on every platform.
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous'; // needed for R2 CORS + Web Audio analyser
  audioEl.preload = 'auto';
  state.audioEl = audioEl;

  // Common UI.
  $('#landing').hidden = true;
  $('#player').hidden = false;
  $('#roomLabel').textContent = `#${state.party!.name}`;
  $('#roleBadge').textContent = state.isHost ? 'HOST' : 'LISTENER';
  $('#roleBadge').classList.toggle('host', state.isHost);
  document.body.classList.toggle('is-listener', !state.isHost);

  $<HTMLButtonElement>('#leaveBtn').addEventListener('click', leave);
  $<HTMLButtonElement>('#inviteBtn').addEventListener('click', openInvite);
  $<HTMLButtonElement>('#closeInviteBtn').addEventListener('click', () => ($('#inviteOverlay').hidden = true));
  $<HTMLButtonElement>('#copyLinkBtn').addEventListener('click', copyInviteLink);

  wireCommonAudio();
  await refreshPlaylist();

  if (state.isHost) setupHost();
  else setupListener();

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
    // Host answers clock pings and shares current state with new arrivals.
    if (m.t === 'clock-ping') send({ t: 'clock-pong', id: m.id, c0: m.c0, h: Date.now() }, [participant.identity]);
    else if (m.t === 'hello') send(currentState(), [participant.identity]);
  } else {
    if (m.t === 'state') applyState(m as SyncState);
    else if (m.t === 'clock-pong') {
      state.clock.sample(m.c0, m.h, Date.now());
      $('#syncDot').hidden = true;
    } else if (m.t === 'playlist') void refreshPlaylist().then(() => state.lastState && applyState(state.lastState));
  }
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
  $('#playerArtist').textContent = `${state.party!.name} · You are hosting`;

  const fileInput = $<HTMLInputElement>('#fileInput');
  $<HTMLButtonElement>('#addMusicBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => void uploadFiles(Array.from(fileInput.files ?? [])));

  $<HTMLButtonElement>('#playPauseBtn').addEventListener('click', () => {
    const a = state.audioEl!;
    if (state.currentIndex === -1 && state.playlist.length) hostLoad(0, true);
    else if (a.paused) void hostPlay();
    else a.pause();
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
    if (isFinite(a.duration)) a.currentTime = (Number(seek.value) / 1000) * a.duration;
    state.seeking = false;
    broadcast();
  });

  // Broadcast transport changes + a periodic heartbeat so late joiners/clocks stay aligned.
  const a = state.audioEl!;
  a.addEventListener('play', broadcast);
  a.addEventListener('pause', broadcast);
  a.addEventListener('seeked', broadcast);
  a.addEventListener('ended', () => hostNext());
  state.timers.push(window.setInterval(broadcast, 3000));

  if (state.currentIndex === -1 && state.playlist.length) hostLoad(0, false);
  updateTransportEnabled();
}

function currentState(): SyncState {
  const a = state.audioEl!;
  return {
    t: 'state',
    key: state.playlist[state.currentIndex]?.key ?? null,
    pos: a.currentTime || 0,
    playing: !a.paused,
    h: Date.now()
  };
}
function broadcast() {
  if (state.isHost) send(currentState());
}

function hostLoad(index: number, autoplay: boolean) {
  if (index < 0 || index >= state.playlist.length) return;
  state.currentIndex = index;
  const track = state.playlist[index];
  state.audioEl!.src = track.url;
  setMeta(track);
  $('#playerArtist').textContent = `${state.party!.name} · You are hosting`;
  renderPlaylist();
  broadcast();
  if (autoplay) void hostPlay();
}
async function hostPlay() {
  ensureGraph(); // gesture path (play button) — safe to set up Web Audio here
  if (state.currentIndex === -1 && state.playlist.length) {
    hostLoad(0, false);
  }
  try {
    await state.audioEl!.play();
  } catch (e) {
    console.error(e);
  }
}
function hostNext() {
  if (state.currentIndex < state.playlist.length - 1) hostLoad(state.currentIndex + 1, true);
  else state.audioEl!.pause();
}
function hostPrev() {
  const a = state.audioEl!;
  if (a.currentTime > 3 || state.currentIndex <= 0) {
    a.currentTime = 0;
    broadcast();
  } else hostLoad(state.currentIndex - 1, !a.paused);
}
function hostSeekBy(s: number) {
  const a = state.audioEl!;
  if (!isFinite(a.duration)) return;
  a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + s));
  broadcast();
}
function updateTransportEnabled() {
  const has = state.playlist.length > 0;
  for (const id of ['playPauseBtn', 'fwdBtn', 'backBtn', 'prevBtn']) {
    $<HTMLButtonElement>(`#${id}`).disabled = !has;
  }
  $<HTMLButtonElement>('#nextBtn').disabled = !has || state.currentIndex >= state.playlist.length - 1;
}

async function uploadFiles(files: File[]) {
  const fileInput = $<HTMLInputElement>('#fileInput');
  fileInput.value = '';
  if (!files.length) return;
  for (const file of files) {
    try {
      const type = file.type || 'audio/mpeg';
      toast(`⬆ Uploading “${file.name}”…`);
      const { url } = await api.uploadUrl(state.party!.id, file.name, type, state.hostPassword);
      const put = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': type } });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      toast(`✅ Added “${file.name}”`);
    } catch (e) {
      console.error(e);
      toast(`⚠ Couldn't upload “${file.name}”`);
    }
  }
  await refreshPlaylist();
  send({ t: 'playlist' }); // tell listeners to refetch
  if (state.currentIndex === -1 && state.playlist.length) hostLoad(0, false);
}

// -----------------------------------------------------------------------------
// LISTENER
// -----------------------------------------------------------------------------
function setupListener() {
  // Listener follows the host: hide host-only transport, keep a local play/pause.
  $('#progressRow').classList.add('readonly');
  $<HTMLInputElement>('#seekBar').disabled = true;
  for (const id of ['prevBtn', 'backBtn', 'fwdBtn', 'nextBtn']) $(`#${id}`).hidden = true;
  $('#playerArtist').textContent = 'Connecting to the host…';

  $<HTMLButtonElement>('#playPauseBtn').addEventListener('click', () => {
    const a = state.audioEl!;
    if (a.paused) {
      state.unlocked = true;
      if (state.lastState) applyState(state.lastState);
    } else a.pause();
  });

  // First gesture: unlock audio, then apply whatever the host is doing.
  $('#unmuteOverlay').hidden = false;
  $<HTMLButtonElement>('#unmuteBtn').addEventListener('click', () => {
    state.unlocked = true;
    ensureGraph();
    $('#unmuteOverlay').hidden = true;
    findHost();
    send({ t: 'hello', name: state.myName }); // ask host for current state
    if (state.lastState) applyState(state.lastState);
  });

  // Clock sync: a quick burst of pings, then occasional re-syncs. Plus drift correction.
  $('#syncDot').hidden = false;
  startClockSync();
  state.timers.push(window.setInterval(driftCorrect, 1500));
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

function applyState(s: SyncState) {
  state.lastState = s;
  if (!state.unlocked) return;
  const a = state.audioEl!;

  if (!s.key) {
    a.pause();
    $('#playerArtist').textContent = 'Host hasn’t started yet…';
    return;
  }

  const idx = state.playlist.findIndex((t) => t.key === s.key);
  if (idx < 0) {
    // We don't have this track yet — refetch and re-apply.
    void refreshPlaylist().then(() => state.lastState && applyState(state.lastState));
    return;
  }

  const target = s.pos + (s.playing ? (state.clock.hostNow() - s.h) / 1000 : 0);

  const apply = () => {
    if (Math.abs(a.currentTime - target) > 0.5) a.currentTime = Math.max(0, target);
    if (s.playing) a.play().catch(() => {});
    else a.pause();
    $('#playerArtist').textContent = s.playing ? '🔴 In sync — live' : '⏸ Host paused';
  };

  if (idx !== state.currentIndex || !a.src) {
    state.currentIndex = idx;
    a.src = state.playlist[idx].url;
    setMeta(state.playlist[idx]);
    renderPlaylist();
    a.addEventListener('loadedmetadata', apply, { once: true });
    a.load();
  } else if (a.readyState >= 1) {
    apply();
  } else {
    a.addEventListener('loadedmetadata', apply, { once: true });
  }
}

// Gently keep the listener locked to the host's timeline using tiny rate nudges,
// hard-seeking only on a big drift (e.g. after a stall).
function driftCorrect() {
  const s = state.lastState;
  const a = state.audioEl;
  if (!s || !a || !state.unlocked || !s.playing || a.paused) return;
  if (state.playlist[state.currentIndex]?.key !== s.key) return;

  const target = s.pos + (state.clock.hostNow() - s.h) / 1000;
  const drift = a.currentTime - target; // +ve = we're ahead
  if (Math.abs(drift) > 1.0) {
    a.currentTime = Math.max(0, target);
    a.playbackRate = 1;
  } else if (Math.abs(drift) > 0.08) {
    a.playbackRate = drift > 0 ? 0.97 : 1.03; // inaudible nudge toward the host
  } else {
    a.playbackRate = 1;
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
        play: () => void hostPlay(),
        pause: () => a.pause(),
        nexttrack: () => hostNext(),
        previoustrack: () => hostPrev(),
        seekforward: () => hostSeekBy(SEEK_SECONDS),
        seekbackward: () => hostSeekBy(-SEEK_SECONDS)
      }
    : {
        play: () => {
          state.unlocked = true;
          if (state.lastState) applyState(state.lastState);
        },
        pause: () => a.pause()
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
