// src/main.ts
// -----------------------------------------------------------------------------
// Sync Music Party — music-player UI + WebRTC sync logic.
//
//  Layout (mobile-first):
//    ┌──────────────────────────────┐
//    │ app bar (room · members)     │
//    │ ┌──────────────────────────┐ │
//    │ │ ARTWORK + visualizer     │ │  ← player card
//    │ │ title / artist           │ │
//    │ │ progress bar (host)      │ │
//    │ │ ⏮  ⏪  ▶/⏸  ⏩  ⏭        │ │
//    │ └──────────────────────────┘ │
//    │ track list (host playlist)   │  ← scrollable
//    │ [ Add ]  [ Invite ]  [ Leave]│  ← bottom function bar
//    └──────────────────────────────┘
//
//  Colors live in theme.css. Icons live in icons.ts (swap freely).
// -----------------------------------------------------------------------------

import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalAudioTrack
} from 'livekit-client';
import QRCode from 'qrcode';

import { icons } from './icons';
import './style.css';

const TOKEN_ENDPOINT = '/api/get-token';
const SEEK_SECONDS = 10;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
interface PlaylistItem {
  name: string;
  url: string;
}
interface AppState {
  room: Room | null;
  isHost: boolean;
  audioCtx: AudioContext | null;
  hostAudioEl: HTMLAudioElement | null;
  publishedTrack: LocalAudioTrack | null;
  graphBuilt: boolean;
  playlist: PlaylistItem[];
  currentIndex: number;
  seeking: boolean;
  listenerAudioEl: HTMLAudioElement | null;
  pendingRemoteTrack: RemoteTrack | null;
  currentRemoteTrack: RemoteTrack | null;
}
const state: AppState = {
  room: null,
  isHost: false,
  audioCtx: null,
  hostAudioEl: null,
  publishedTrack: null,
  graphBuilt: false,
  playlist: [],
  currentIndex: -1,
  seeking: false,
  listenerAudioEl: null,
  pendingRemoteTrack: null,
  currentRemoteTrack: null
};

// -----------------------------------------------------------------------------
// Markup
// -----------------------------------------------------------------------------
$('#app').innerHTML = /* html */ `
  <!-- LANDING -->
  <main class="screen landing" id="landing">
    <div class="brand">
      <div class="brand-mark">${icons.note}</div>
      <h1>Sync Party</h1>
      <p class="sub">Listen together, perfectly in sync.</p>
    </div>

    <label class="field">
      <span>Room name</span>
      <input id="roomInput" type="text" autocomplete="off" inputmode="text" placeholder="friday-night" />
    </label>
    <label class="field">
      <span>Your nickname</span>
      <input id="nameInput" type="text" autocomplete="off" placeholder="alex" />
    </label>
    <label class="toggle">
      <input id="hostCheckbox" type="checkbox" />
      <span>I'm the Host <small>(I'll play the music)</small></span>
    </label>

    <button id="enterBtn" class="btn-primary">Enter Room</button>
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
        <span id="memberCount" class="members">${icons.users}<b>1</b></span>
        <span id="statusDot" class="status disconnected" title="connection"></span>
      </div>
    </header>

    <section class="player-card">
      <div class="artwork" id="artwork">
        <div class="art-eq" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <div class="art-icon">${icons.note}</div>
      </div>

      <div class="track-meta">
        <h2 id="playerTitle">Nothing playing</h2>
        <p id="playerArtist">Live Sync Party</p>
      </div>

      <!-- host scrubber -->
      <div class="progress" id="progressRow">
        <span id="curTime" class="t">0:00</span>
        <input id="seekBar" class="seek" type="range" min="0" max="1000" value="0" step="1" />
        <span id="totTime" class="t">0:00</span>
      </div>
      <!-- listener live indicator -->
      <div class="live-row" id="liveRow" hidden><span class="live-badge">● LIVE</span></div>

      <div class="controls" id="controls">
        <button id="prevBtn" class="ctrl" title="Previous" aria-label="Previous">${icons.prev}</button>
        <button id="backBtn" class="ctrl" title="Back ${SEEK_SECONDS}s" aria-label="Rewind">${icons.rewind}</button>
        <button id="playPauseBtn" class="ctrl play" title="Play / Pause" aria-label="Play or pause">${icons.play}</button>
        <button id="fwdBtn" class="ctrl" title="Forward ${SEEK_SECONDS}s" aria-label="Forward">${icons.forward}</button>
        <button id="nextBtn" class="ctrl" title="Next" aria-label="Next">${icons.next}</button>
      </div>
    </section>

    <section class="content" id="content">
      <div class="list-head"><span id="listTitle">Up Next</span><span id="listCount" class="list-count"></span></div>
      <ul id="playlist" class="playlist"></ul>
      <p id="emptyHint" class="empty-hint">No tracks yet — tap the ＋ button to add music.</p>
    </section>

    <nav class="bottom-bar">
      <button class="tab" id="addMusicBtn">${icons.add}<small>Add music</small></button>
      <button class="tab" id="inviteBtn">${icons.qr}<small>Invite</small></button>
      <button class="tab danger" id="leaveBtn">${icons.leave}<small>Leave</small></button>
    </nav>

    <input id="fileInput" type="file" accept="audio/*" multiple hidden />
  </main>

  <!-- Unmute overlay (listeners) -->
  <div id="unmuteOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <div class="overlay-icon">🔊</div>
      <h2>Stream is live</h2>
      <p>Mobile browsers block audio until you tap. One tap and you're in.</p>
      <button id="unmuteBtn" class="btn-primary big">Tap to Unmute &amp; Connect</button>
    </div>
  </div>

  <!-- Invite QR overlay (host) -->
  <div id="inviteOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <button id="closeInviteBtn" class="overlay-close" aria-label="Close">${icons.close}</button>
      <h2>Scan to join 🎉</h2>
      <p>Friends scan this to drop straight into the party.</p>
      <img id="qrImg" class="qr" alt="Scan to join" />
      <button id="copyLinkBtn" class="btn-primary">${icons.copy}<span>Copy invite link</span></button>
    </div>
  </div>
`;

// -----------------------------------------------------------------------------
// Landing + QR auto-join
// -----------------------------------------------------------------------------
const enterBtn = $<HTMLButtonElement>('#enterBtn');
enterBtn.addEventListener('click', () => {
  void joinRoom(
    $<HTMLInputElement>('#roomInput').value.trim(),
    $<HTMLInputElement>('#nameInput').value.trim(),
    $<HTMLInputElement>('#hostCheckbox').checked
  );
});

handleInviteLink();
function handleInviteLink() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (!room) return;
  $<HTMLInputElement>('#roomInput').value = room;
  $<HTMLInputElement>('#hostCheckbox').checked = false;
  const guestName = params.get('name') || `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
  $<HTMLInputElement>('#nameInput').value = guestName;
  history.replaceState(null, '', location.pathname);
  void joinRoom(room, guestName, false); // scanned guests auto-join as listeners
}

async function joinRoom(roomName: string, participantName: string, isHost: boolean) {
  const errEl = $('#landingError');
  errEl.hidden = true;
  if (!roomName || !participantName) {
    errEl.textContent = 'Please enter both a room name and a nickname.';
    errEl.hidden = false;
    return;
  }
  enterBtn.disabled = true;
  enterBtn.textContent = 'Connecting…';
  try {
    if (isHost) {
      state.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const { token, url } = await fetchToken(roomName, participantName, isHost);
    await connectToRoom(url, token, isHost, roomName);
  } catch (err) {
    console.error(err);
    errEl.textContent = err instanceof Error ? err.message : 'Failed to connect.';
    errEl.hidden = false;
    enterBtn.disabled = false;
    enterBtn.textContent = 'Enter Room';
  }
}

async function fetchToken(roomName: string, participantName: string, isHost: boolean) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName, participantName, isHost })
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error || 'Token request failed.');
  }
  return res.json() as Promise<{ token: string; url: string }>;
}

// -----------------------------------------------------------------------------
// Connect
// -----------------------------------------------------------------------------
async function connectToRoom(url: string, token: string, isHost: boolean, roomName: string) {
  state.isHost = isHost;
  const room = new Room({ adaptiveStream: false, dynacast: true });
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

  if (!isHost) wireListenerEvents(room);

  await room.connect(url, token);

  $('#landing').hidden = true;
  $('#player').hidden = false;
  $('#roomLabel').textContent = `#${roomName}`;
  $('#roleBadge').textContent = isHost ? 'HOST' : 'LISTENER';
  $('#roleBadge').classList.toggle('host', isHost);

  document.body.classList.toggle('is-listener', !isHost);

  if (isHost) {
    setupHost(roomName);
  } else {
    // Listener view: hide host-only chrome, show the LIVE now-playing layout.
    $('#progressRow').hidden = true;
    $('#liveRow').hidden = false;
    $('#content').hidden = true;
    for (const id of ['prevBtn', 'backBtn', 'fwdBtn', 'nextBtn', 'addMusicBtn', 'inviteBtn']) {
      $(`#${id}`).hidden = true;
    }
    $('#playerTitle').textContent = 'Live Sync Party';
    $('#playerArtist').textContent = 'Connecting…';
  }

  $<HTMLButtonElement>('#leaveBtn').addEventListener('click', () => leaveRoom());
}

// -----------------------------------------------------------------------------
// Shared: reflect playback into the UI (icon, visualizer, Media Session)
// -----------------------------------------------------------------------------
function reflectPlayback(isPlaying: boolean) {
  $('#playPauseBtn').innerHTML = isPlaying ? icons.pause : icons.play;
  $('#artwork').classList.toggle('playing', isPlaying);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }
}

// -----------------------------------------------------------------------------
// HOST
// -----------------------------------------------------------------------------
function setupHost(roomName: string) {
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  audioEl.preload = 'auto';
  state.hostAudioEl = audioEl;

  const fileInput = $<HTMLInputElement>('#fileInput');
  const seekBar = $<HTMLInputElement>('#seekBar');

  $<HTMLButtonElement>('#addMusicBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    if (!files.length) return;
    for (const f of files) state.playlist.push({ name: f.name, url: URL.createObjectURL(f) });
    fileInput.value = '';
    renderPlaylist();
    if (state.currentIndex === -1) loadTrack(0, false);
  });

  // Transport
  $<HTMLButtonElement>('#playPauseBtn').addEventListener('click', () => togglePlay());
  $<HTMLButtonElement>('#nextBtn').addEventListener('click', () => playNext());
  $<HTMLButtonElement>('#prevBtn').addEventListener('click', () => playPrev());
  $<HTMLButtonElement>('#fwdBtn').addEventListener('click', () => seekBy(SEEK_SECONDS));
  $<HTMLButtonElement>('#backBtn').addEventListener('click', () => seekBy(-SEEK_SECONDS));

  // Scrubber (drag to seek)
  seekBar.addEventListener('input', () => {
    state.seeking = true;
    if (isFinite(audioEl.duration)) {
      $('#curTime').textContent = fmt((Number(seekBar.value) / 1000) * audioEl.duration);
    }
  });
  seekBar.addEventListener('change', () => {
    if (isFinite(audioEl.duration)) {
      audioEl.currentTime = (Number(seekBar.value) / 1000) * audioEl.duration;
    }
    state.seeking = false;
  });

  // Element lifecycle
  audioEl.addEventListener('play', () => reflectPlayback(true));
  audioEl.addEventListener('pause', () => reflectPlayback(false));
  audioEl.addEventListener('timeupdate', updateProgress);
  audioEl.addEventListener('loadedmetadata', updateProgress);
  audioEl.addEventListener('ended', () => playNext());

  // Invite
  $<HTMLButtonElement>('#inviteBtn').addEventListener('click', () => openInvite(roomName));
  $<HTMLButtonElement>('#closeInviteBtn').addEventListener('click', () => ($('#inviteOverlay').hidden = true));
  $<HTMLButtonElement>('#copyLinkBtn').addEventListener('click', () => copyInviteLink(roomName));

  // Full lock-screen transport
  setupMediaSession({
    play: () => audioEl.play(),
    pause: () => audioEl.pause(),
    nexttrack: () => playNext(),
    previoustrack: () => playPrev(),
    seekforward: () => seekBy(SEEK_SECONDS),
    seekbackward: () => seekBy(-SEEK_SECONDS)
  });

  renderPlaylist();
}

function renderPlaylist() {
  const ul = $('#playlist');
  ul.innerHTML = state.playlist
    .map(
      (item, i) => `
      <li class="${i === state.currentIndex ? 'active' : ''}" data-i="${i}">
        <span class="pl-art">${i === state.currentIndex ? `<span class="pl-eq"><i></i><i></i><i></i></span>` : icons.note}</span>
        <span class="pl-name">${escapeHtml(item.name)}</span>
        <span class="pl-idx">${i + 1}</span>
      </li>`
    )
    .join('');
  ul.querySelectorAll<HTMLLIElement>('li').forEach((li) =>
    li.addEventListener('click', () => loadTrack(Number(li.dataset.i), !state.hostAudioEl?.paused))
  );
  $('#emptyHint').hidden = state.playlist.length > 0;
  $('#listCount').textContent = state.playlist.length ? `${state.playlist.length} tracks` : '';
  updateTransportEnabled();
}

function loadTrack(index: number, autoplay: boolean) {
  if (index < 0 || index >= state.playlist.length) return;
  state.currentIndex = index;
  const item = state.playlist[index];
  state.hostAudioEl!.src = item.url;
  $('#playerTitle').textContent = item.name;
  $('#playerArtist').textContent = 'Sync Party · You are hosting';
  updateMediaMetadata(item.name, 'Live Sync Party');
  renderPlaylist();
  if (autoplay) void startPlayback();
}

async function startPlayback() {
  const room = state.room!;
  const audioEl = state.hostAudioEl!;
  const ctx = state.audioCtx!;
  if (ctx.state === 'suspended') await ctx.resume();

  if (!state.graphBuilt) {
    // Web Audio capture graph (portable; captureStream() is unsupported on iOS Safari).
    // Built ONCE — createMediaElementSource may run only once per element, and we reuse
    // the same element across the whole playlist, so track changes keep the stream alive.
    const sourceNode = ctx.createMediaElementSource(audioEl);
    const streamDest = ctx.createMediaStreamDestination();
    sourceNode.connect(ctx.destination); // host monitors locally
    sourceNode.connect(streamDest); // broadcast tap
    const [mediaStreamTrack] = streamDest.stream.getAudioTracks();
    const pub = await room.localParticipant.publishTrack(mediaStreamTrack, {
      name: 'music',
      source: Track.Source.Microphone,
      dtx: false,
      red: true,
      stopMicTrackOnMute: false
    });
    state.publishedTrack = pub.audioTrack as LocalAudioTrack;
    state.graphBuilt = true;
  }
  await audioEl.play();
}

function togglePlay() {
  const a = state.hostAudioEl!;
  if (state.currentIndex === -1) return;
  if (a.paused) void startPlayback();
  else a.pause();
}
function playNext() {
  if (state.currentIndex < state.playlist.length - 1) loadTrack(state.currentIndex + 1, true);
  else state.hostAudioEl?.pause();
}
function playPrev() {
  const a = state.hostAudioEl!;
  if (a.currentTime > 3 || state.currentIndex <= 0) a.currentTime = 0;
  else loadTrack(state.currentIndex - 1, !a.paused);
}
function seekBy(seconds: number) {
  const a = state.hostAudioEl!;
  if (!isFinite(a.duration)) return;
  a.currentTime = Math.max(0, Math.min(a.duration, a.currentTime + seconds));
}
function updateTransportEnabled() {
  const has = state.playlist.length > 0;
  for (const id of ['playPauseBtn', 'fwdBtn', 'backBtn', 'prevBtn']) {
    $<HTMLButtonElement>(`#${id}`).disabled = !has;
  }
  $<HTMLButtonElement>('#nextBtn').disabled = !has || state.currentIndex >= state.playlist.length - 1;
}
function updateProgress() {
  const a = state.hostAudioEl!;
  $('#totTime').textContent = fmt(a.duration);
  if (state.seeking) return;
  $('#curTime').textContent = fmt(a.currentTime);
  const pct = isFinite(a.duration) && a.duration > 0 ? (a.currentTime / a.duration) * 1000 : 0;
  const seek = $<HTMLInputElement>('#seekBar');
  seek.value = String(pct);
  // paint the filled portion of the track (CSS uses --pct)
  seek.style.setProperty('--pct', `${pct / 10}%`);
}

// -----------------------------------------------------------------------------
// LISTENER
// -----------------------------------------------------------------------------
function wireListenerEvents(room: Room) {
  const audioEl = new Audio();
  audioEl.autoplay = false;
  state.listenerAudioEl = audioEl;

  const playPauseBtn = $<HTMLButtonElement>('#playPauseBtn');

  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, _p: RemoteTrackPublication, _x: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      state.pendingRemoteTrack = track; // wait for tap; no autoplay on mobile
      $('#playerArtist').textContent = 'Host is live — tap to listen';
      $('#unmuteOverlay').hidden = false;
    }
  );
  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    track.detach();
    state.pendingRemoteTrack = null;
    state.currentRemoteTrack = null;
    $('#playerArtist').textContent = 'Host paused or left. Waiting…';
    reflectPlayback(false);
  });

  audioEl.addEventListener('play', () => {
    reflectPlayback(true);
    $('#playerArtist').textContent = 'Listening live';
  });
  audioEl.addEventListener('pause', () => {
    reflectPlayback(false);
    $('#playerArtist').textContent = 'Paused — tap play to jump back to live';
  });

  $<HTMLButtonElement>('#unmuteBtn').addEventListener('click', async () => {
    if (!state.pendingRemoteTrack) {
      $('#unmuteOverlay').hidden = true;
      return;
    }
    await listenerPlay();
    updateMediaMetadata('Live Sync Party', 'Host Stream');
    setupMediaSession({ play: () => void listenerPlay(), pause: () => audioEl.pause() });
    $('#unmuteOverlay').hidden = true;
  });

  playPauseBtn.addEventListener('click', () => {
    if (audioEl.paused) void listenerPlay();
    else audioEl.pause();
  });
}

// Resume AND snap to the live edge. A paused element can buffer stale audio; detach +
// re-attach flushes it so "play" always means "in sync with the host".
async function listenerPlay() {
  const track = state.pendingRemoteTrack;
  const audioEl = state.listenerAudioEl!;
  if (!track) return;
  if (state.currentRemoteTrack) track.detach(audioEl);
  track.attach(audioEl);
  state.currentRemoteTrack = track;
  try {
    await audioEl.play();
  } catch (e) {
    console.error('play() rejected:', e);
  }
}

// -----------------------------------------------------------------------------
// Invite by QR
// -----------------------------------------------------------------------------
const inviteUrl = (roomName: string) => `${location.origin}/?room=${encodeURIComponent(roomName)}`;

async function openInvite(roomName: string) {
  const dataUrl = await QRCode.toDataURL(inviteUrl(roomName), {
    width: 320,
    margin: 1,
    color: { dark: '#0c0a14', light: '#ffffff' }
  });
  $<HTMLImageElement>('#qrImg').src = dataUrl;
  $('#inviteOverlay').hidden = false;
}
async function copyInviteLink(roomName: string) {
  const btn = $<HTMLButtonElement>('#copyLinkBtn');
  const span = btn.querySelector('span')!;
  try {
    await navigator.clipboard.writeText(inviteUrl(roomName));
    span.textContent = 'Copied! ✓';
  } catch {
    span.textContent = inviteUrl(roomName);
  }
  setTimeout(() => (span.textContent = 'Copy invite link'), 2000);
}

// -----------------------------------------------------------------------------
// Media Session (background playback workaround — host AND listener)
// -----------------------------------------------------------------------------
type MediaHandlers = Partial<Record<MediaSessionAction, () => void>>;
function setupMediaSession(handlers: MediaHandlers) {
  if (!('mediaSession' in navigator)) return;
  const ALL: MediaSessionAction[] = [
    'play',
    'pause',
    'nexttrack',
    'previoustrack',
    'seekforward',
    'seekbackward'
  ];
  for (const action of ALL) {
    const fn = handlers[action];
    try {
      navigator.mediaSession.setActionHandler(
        action,
        fn
          ? () => {
              fn();
              if (action === 'play') navigator.mediaSession.playbackState = 'playing';
              if (action === 'pause') navigator.mediaSession.playbackState = 'paused';
            }
          : null
      );
    } catch {
      /* unsupported action — ignore */
    }
  }
}
function updateMediaMetadata(title: string, artist: string) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist,
    album: 'Sync Music Party',
    artwork: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
}

// -----------------------------------------------------------------------------
// Leave / cleanup + utils
// -----------------------------------------------------------------------------
async function leaveRoom() {
  try {
    await state.room?.disconnect();
  } finally {
    state.publishedTrack?.stop();
    state.hostAudioEl?.pause();
    state.listenerAudioEl?.pause();
    state.playlist.forEach((p) => URL.revokeObjectURL(p.url));
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
