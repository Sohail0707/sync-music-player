// src/main.ts
// -----------------------------------------------------------------------------
// Sync Music Party — single-file app logic.
//
//  Host    : builds a PLAYLIST of local audio files -> routes the active one
//            through Web Audio -> publishes the resulting MediaStreamTrack to
//            LiveKit. Full transport (prev / -10s / play-pause / +10s / next).
//  Listener: subscribes to the host's track -> waits for a user TAP ->
//            attaches the track to an <audio> element and plays it.
//  Invite  : host shows a QR code; scanning it opens the app with ?room=...
//            and auto-joins the scanner straight into the party as a listener.
//
//  Background playback is kept alive on iOS Safari + Android Chrome via the
//  Media Session API (see setupMediaSession()).
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

import './style.css';

const TOKEN_ENDPOINT = '/api/get-token';
const SEEK_SECONDS = 10;

// -----------------------------------------------------------------------------
// Tiny DOM helper
// -----------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

// -----------------------------------------------------------------------------
// App state
// -----------------------------------------------------------------------------
interface PlaylistItem {
  name: string;
  url: string; // object URL — fully local, nothing is uploaded
}

interface AppState {
  room: Room | null;
  isHost: boolean;
  // Host audio graph:
  audioCtx: AudioContext | null;
  hostAudioEl: HTMLAudioElement | null;
  publishedTrack: LocalAudioTrack | null;
  graphBuilt: boolean;
  // Host playlist:
  playlist: PlaylistItem[];
  currentIndex: number;
  // Listener:
  listenerAudioEl: HTMLAudioElement | null;
  pendingRemoteTrack: RemoteTrack | null;
  currentRemoteTrack: RemoteTrack | null; // the track currently attached to our element
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
  listenerAudioEl: null,
  pendingRemoteTrack: null,
  currentRemoteTrack: null
};

// -----------------------------------------------------------------------------
// Markup
// -----------------------------------------------------------------------------
$('#app').innerHTML = /* html */ `
  <main class="screen" id="landing">
    <h1>🎧 Sync Party</h1>
    <p class="sub">Listen together, perfectly in sync.</p>

    <label class="field">
      <span>Room name</span>
      <input id="roomInput" type="text" autocomplete="off" placeholder="friday-night" />
    </label>

    <label class="field">
      <span>Your nickname</span>
      <input id="nameInput" type="text" autocomplete="off" placeholder="alex" />
    </label>

    <label class="toggle">
      <input id="hostCheckbox" type="checkbox" />
      <span>I am the Host (I'll play the music)</span>
    </label>

    <button id="enterBtn" class="primary">Enter Room</button>
    <p id="landingError" class="error" hidden></p>
  </main>

  <main class="screen" id="room" hidden>
    <header class="room-header">
      <span id="roleBadge" class="badge">—</span>
      <span id="roomLabel" class="room-label"></span>
      <span id="memberCount" class="members" title="people in the room">👥 1</span>
      <span id="statusDot" class="status disconnected" title="connection"></span>
    </header>

    <!-- HOST -->
    <section id="hostPanel" hidden>
      <div class="now-playing compact">
        <p id="trackName">No file loaded</p>
        <small id="trackPos">--:-- / --:--</small>
      </div>

      <!-- transport / control panel -->
      <div class="transport">
        <button id="prevBtn" title="Previous track" disabled>⏮</button>
        <button id="backBtn" title="Back ${SEEK_SECONDS}s" disabled>⏪</button>
        <button id="playPauseBtn" class="primary" title="Play / Pause" disabled>▶</button>
        <button id="fwdBtn" title="Forward ${SEEK_SECONDS}s" disabled>⏩</button>
        <button id="nextBtn" title="Next track" disabled>⏭</button>
      </div>

      <ul id="playlist" class="playlist"></ul>

      <label class="field add-files">
        <span>Add audio files</span>
        <input id="fileInput" type="file" accept="audio/*" multiple />
      </label>

      <button id="inviteBtn" class="ghost">📷 Invite friends by QR</button>
      <p class="hint">Listeners hear exactly what you play. Keep this tab open.</p>
    </section>

    <!-- LISTENER -->
    <section id="listenerPanel" hidden>
      <h2>Live stream</h2>
      <p id="listenerStatus" class="listener-status">Waiting for the host to start…</p>
      <div class="now-playing">
        <div class="vinyl" id="vinyl">💿</div>
        <p>Live Sync Party</p>
        <small>Host Stream</small>
      </div>

      <div class="transport listener-transport" id="listenerControls" hidden>
        <button id="listenerPlayPause" class="primary" title="Play / Pause">⏸</button>
      </div>
    </section>

    <button id="leaveBtn" class="ghost">Leave room</button>
  </main>

  <!-- Mobile-autoplay unlock overlay (listeners) -->
  <div id="unmuteOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <h2>🔊 Stream is live</h2>
      <p>Mobile browsers block audio until you tap. One tap and you're in.</p>
      <button id="unmuteBtn" class="primary big">Tap to Unmute &amp; Connect to Live Stream</button>
    </div>
  </div>

  <!-- Invite-by-QR overlay (host) -->
  <div id="inviteOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <h2>Scan to join 🎉</h2>
      <p>Friends scan this to drop straight into the party.</p>
      <img id="qrImg" class="qr" alt="Scan to join the party" />
      <button id="copyLinkBtn" class="primary">Copy invite link</button>
      <button id="closeInviteBtn" class="ghost">Close</button>
    </div>
  </div>
`;

// -----------------------------------------------------------------------------
// Landing screen wiring + QR auto-join
// -----------------------------------------------------------------------------
const enterBtn = $<HTMLButtonElement>('#enterBtn');

enterBtn.addEventListener('click', () => {
  const roomName = $<HTMLInputElement>('#roomInput').value.trim();
  const participantName = $<HTMLInputElement>('#nameInput').value.trim();
  const isHost = $<HTMLInputElement>('#hostCheckbox').checked;
  void joinRoom(roomName, participantName, isHost);
});

// On load: if we arrived from a scanned QR (?room=...), pre-fill and auto-join as
// a listener so the scanner lands directly in the party.
handleInviteLink();

function handleInviteLink() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (!room) return;

  // Pre-fill the form for transparency, force listener mode.
  $<HTMLInputElement>('#roomInput').value = room;
  $<HTMLInputElement>('#hostCheckbox').checked = false;

  // A scanned guest hasn't typed a name; generate a friendly one. Connecting to
  // LiveKit needs no user gesture (only audio playback does), so we can auto-join —
  // the listener still taps the unmute overlay, which satisfies mobile autoplay.
  const guestName = params.get('name') || `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
  $<HTMLInputElement>('#nameInput').value = guestName;

  // Clean the URL so a refresh doesn't keep re-triggering.
  history.replaceState(null, '', location.pathname);

  void joinRoom(room, guestName, false);
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
    // iOS: the AudioContext must be created inside a user gesture. The "Enter Room"
    // click is that gesture for the host. (Listeners need no AudioContext.)
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

// -----------------------------------------------------------------------------
// Token fetch
// -----------------------------------------------------------------------------
async function fetchToken(
  roomName: string,
  participantName: string,
  isHost: boolean
): Promise<{ token: string; url: string }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName, participantName, isHost })
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error || 'Token request failed.');
  }
  return res.json();
}

// -----------------------------------------------------------------------------
// Connect to the LiveKit room
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

  // Live member count (host + listeners). remoteParticipants excludes us, so +1.
  const updateMembers = () => {
    $('#memberCount').textContent = `👥 ${room.remoteParticipants.size + 1}`;
  };
  room
    .on(RoomEvent.Connected, updateMembers)
    .on(RoomEvent.ParticipantConnected, updateMembers)
    .on(RoomEvent.ParticipantDisconnected, updateMembers);

  if (!isHost) wireListenerEvents(room);

  await room.connect(url, token);

  $('#landing').hidden = true;
  $('#room').hidden = false;
  $('#roomLabel').textContent = `#${roomName}`;
  $('#roleBadge').textContent = isHost ? 'HOST' : 'LISTENER';
  $('#roleBadge').classList.toggle('host', isHost);

  if (isHost) {
    $('#hostPanel').hidden = false;
    setupHost(roomName);
  } else {
    $('#listenerPanel').hidden = false;
  }

  $<HTMLButtonElement>('#leaveBtn').addEventListener('click', () => leaveRoom());
}

// -----------------------------------------------------------------------------
// HOST: playlist + transport + Web Audio -> LiveKit publish
// -----------------------------------------------------------------------------
function setupHost(roomName: string) {
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  audioEl.preload = 'auto';
  state.hostAudioEl = audioEl;

  const fileInput = $<HTMLInputElement>('#fileInput');
  const playPauseBtn = $<HTMLButtonElement>('#playPauseBtn');

  // --- Playlist building ---
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    if (!files.length) return;
    for (const file of files) {
      state.playlist.push({ name: file.name, url: URL.createObjectURL(file) });
    }
    fileInput.value = ''; // allow re-adding the same file later
    renderPlaylist();
    // If nothing is loaded yet, cue the first added track.
    if (state.currentIndex === -1) loadTrack(0, false);
  });

  // --- Transport buttons ---
  playPauseBtn.addEventListener('click', () => togglePlay());
  $<HTMLButtonElement>('#nextBtn').addEventListener('click', () => playNext());
  $<HTMLButtonElement>('#prevBtn').addEventListener('click', () => playPrev());
  $<HTMLButtonElement>('#fwdBtn').addEventListener('click', () => seekBy(SEEK_SECONDS));
  $<HTMLButtonElement>('#backBtn').addEventListener('click', () => seekBy(-SEEK_SECONDS));

  // --- Audio element lifecycle -> UI + Media Session ---
  audioEl.addEventListener('play', () => {
    playPauseBtn.textContent = '⏸';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  audioEl.addEventListener('pause', () => {
    playPauseBtn.textContent = '▶';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  audioEl.addEventListener('timeupdate', updatePositionLabel);
  audioEl.addEventListener('loadedmetadata', updatePositionLabel);
  // Auto-advance to the next track when one finishes.
  audioEl.addEventListener('ended', () => playNext());

  // --- Invite by QR ---
  $<HTMLButtonElement>('#inviteBtn').addEventListener('click', () => openInvite(roomName));
  $<HTMLButtonElement>('#closeInviteBtn').addEventListener('click', () => ($('#inviteOverlay').hidden = true));
  $<HTMLButtonElement>('#copyLinkBtn').addEventListener('click', () => copyInviteLink(roomName));

  // --- Media Session: full lock-screen transport for the host ---
  setupMediaSession({
    play: () => audioEl.play(),
    pause: () => audioEl.pause(),
    nexttrack: () => playNext(),
    previoustrack: () => playPrev(),
    seekforward: () => seekBy(SEEK_SECONDS),
    seekbackward: () => seekBy(-SEEK_SECONDS)
  });
}

function renderPlaylist() {
  const ul = $('#playlist');
  ul.innerHTML = state.playlist
    .map(
      (item, i) =>
        `<li class="${i === state.currentIndex ? 'active' : ''}" data-i="${i}">
           <span class="idx">${i + 1}</span>
           <span class="pl-name">${escapeHtml(item.name)}</span>
         </li>`
    )
    .join('');
  // Click a row to jump to that track.
  ul.querySelectorAll<HTMLLIElement>('li').forEach((li) => {
    li.addEventListener('click', () => {
      const i = Number(li.dataset.i);
      const wasPlaying = !state.hostAudioEl?.paused;
      loadTrack(i, wasPlaying);
    });
  });
  updateTransportEnabled();
}

function loadTrack(index: number, autoplay: boolean) {
  if (index < 0 || index >= state.playlist.length) return;
  state.currentIndex = index;
  const item = state.playlist[index];
  const audioEl = state.hostAudioEl!;
  audioEl.src = item.url;

  $('#trackName').textContent = item.name;
  updateMediaMetadata(item.name, 'Live Sync Party');
  renderPlaylist();

  if (autoplay) void startPlayback();
}

// Build the capture graph once (lazily, inside a gesture), then play.
async function startPlayback() {
  const room = state.room!;
  const audioEl = state.hostAudioEl!;
  const ctx = state.audioCtx!;

  if (ctx.state === 'suspended') await ctx.resume();

  if (!state.graphBuilt) {
    // Why Web Audio + MediaStreamDestination over audioEl.captureStream()?
    //   captureStream() is unsupported on iOS Safari and flaky elsewhere. Routing
    //   through an AudioContext is the portable path. createMediaElementSource may
    //   only be called ONCE per element — we reuse the SAME element across the
    //   playlist (just swapping .src), so the graph survives track changes.
    const sourceNode = ctx.createMediaElementSource(audioEl);
    const streamDest = ctx.createMediaStreamDestination();
    sourceNode.connect(ctx.destination); // host monitors locally
    sourceNode.connect(streamDest); // this is what we broadcast

    const [mediaStreamTrack] = streamDest.stream.getAudioTracks();
    const pub = await room.localParticipant.publishTrack(mediaStreamTrack, {
      name: 'music',
      source: Track.Source.Microphone,
      dtx: false, // music: never use discontinuous transmission
      red: true, // redundant encoding -> packet-loss resilience
      stopMicTrackOnMute: false
    });
    state.publishedTrack = pub.audioTrack as LocalAudioTrack;
    state.graphBuilt = true;
  }

  await audioEl.play();
}

function togglePlay() {
  const audioEl = state.hostAudioEl!;
  if (audioEl.paused) void startPlayback();
  else audioEl.pause();
}

function playNext() {
  if (state.currentIndex < state.playlist.length - 1) {
    loadTrack(state.currentIndex + 1, true);
  } else {
    state.hostAudioEl?.pause(); // end of playlist
  }
}

function playPrev() {
  const audioEl = state.hostAudioEl!;
  // Standard music-player behaviour: if >3s in, restart current track; else go back.
  if (audioEl.currentTime > 3 || state.currentIndex === 0) {
    audioEl.currentTime = 0;
  } else {
    loadTrack(state.currentIndex - 1, !audioEl.paused);
  }
}

function seekBy(seconds: number) {
  const audioEl = state.hostAudioEl!;
  if (!isFinite(audioEl.duration)) return;
  audioEl.currentTime = Math.max(0, Math.min(audioEl.duration, audioEl.currentTime + seconds));
}

function updateTransportEnabled() {
  const has = state.playlist.length > 0;
  for (const id of ['playPauseBtn', 'fwdBtn', 'backBtn']) {
    $<HTMLButtonElement>(`#${id}`).disabled = !has;
  }
  $<HTMLButtonElement>('#prevBtn').disabled = !has;
  $<HTMLButtonElement>('#nextBtn').disabled = !has || state.currentIndex >= state.playlist.length - 1;
}

function updatePositionLabel() {
  const a = state.hostAudioEl!;
  $('#trackPos').textContent = `${fmt(a.currentTime)} / ${fmt(a.duration)}`;
}

// -----------------------------------------------------------------------------
// LISTENER: subscribe -> tap -> attach + play
// -----------------------------------------------------------------------------
function wireListenerEvents(room: Room) {
  const audioEl = new Audio();
  audioEl.autoplay = false; // NEVER autoplay — mobile silently blocks it
  state.listenerAudioEl = audioEl;

  const playPauseBtn = $<HTMLButtonElement>('#listenerPlayPause');

  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      // Stash + show overlay. DO NOT attach/play here — needs a user gesture.
      state.pendingRemoteTrack = track;
      $('#listenerStatus').textContent = 'Host is live!';
      $('#unmuteOverlay').hidden = false;
    }
  );

  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    track.detach();
    state.pendingRemoteTrack = null;
    state.currentRemoteTrack = null;
    $('#listenerStatus').textContent = 'Host paused or left. Waiting…';
    $('#vinyl').classList.remove('spinning');
    $('#listenerControls').hidden = true;
  });

  // Keep button label + vinyl + Media Session state in sync with the element.
  audioEl.addEventListener('play', () => {
    playPauseBtn.textContent = '⏸';
    $('#vinyl').classList.add('spinning');
    $('#listenerStatus').textContent = '🔴 Listening live';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  audioEl.addEventListener('pause', () => {
    playPauseBtn.textContent = '▶';
    $('#vinyl').classList.remove('spinning');
    $('#listenerStatus').textContent = '⏸ Paused — tap play to jump back to live';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });

  // The unmute button is the required first user gesture.
  $<HTMLButtonElement>('#unmuteBtn').addEventListener('click', async () => {
    if (!state.pendingRemoteTrack) {
      $('#unmuteOverlay').hidden = true;
      return;
    }
    await listenerPlay(); // attach + play INSIDE the click -> satisfies autoplay rule

    updateMediaMetadata('Live Sync Party', 'Host Stream');
    // Listeners control only their own local playback. Pressing play (here or from the
    // lock screen) re-syncs to the live edge — see listenerPlay().
    setupMediaSession({
      play: () => void listenerPlay(),
      pause: () => audioEl.pause()
    });

    $('#listenerControls').hidden = false;
    $('#unmuteOverlay').hidden = true;
  });

  // Local play/pause toggle.
  playPauseBtn.addEventListener('click', () => {
    if (audioEl.paused) void listenerPlay();
    else audioEl.pause();
  });
}

// Resume playback AND snap to the live edge.
//
// A live WebRTC track has no seekable history, but when an <audio> element is paused
// it can accumulate a small buffer; resuming would play that stale audio and drift the
// listener out of sync with everyone else. Detaching + re-attaching the track flushes
// the element and forces it to resume from the current live frame — so "play" always
// means "play in sync with the host", which is exactly what we want for a party.
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
function inviteUrl(roomName: string) {
  return `${location.origin}/?room=${encodeURIComponent(roomName)}`;
}

async function openInvite(roomName: string) {
  const url = inviteUrl(roomName);
  // Render the QR locally (no third-party service => the room name never leaves the device).
  const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 1 });
  $<HTMLImageElement>('#qrImg').src = dataUrl;
  $('#inviteOverlay').hidden = false;
}

async function copyInviteLink(roomName: string) {
  const url = inviteUrl(roomName);
  const btn = $<HTMLButtonElement>('#copyLinkBtn');
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Copied! ✓';
  } catch {
    btn.textContent = url; // clipboard blocked (e.g. non-HTTPS) — show it to copy by hand
  }
  setTimeout(() => (btn.textContent = 'Copy invite link'), 2000);
}

// -----------------------------------------------------------------------------
// MEDIA SESSION API — background-playback workaround (Host AND Listener)
// -----------------------------------------------------------------------------
// Registering metadata + action handlers tells iOS Safari / Android Chrome this tab
// is an active *media* session, so the OS keeps the audio thread alive when the screen
// locks or the PWA is backgrounded, and shows lock-screen transport controls. The
// handlers MUST exist — an absent/empty handler set lets the OS reclaim media focus.
type MediaHandlers = Partial<Record<MediaSessionAction, () => void>>;

function setupMediaSession(handlers: MediaHandlers) {
  if (!('mediaSession' in navigator)) return;

  // Actions we don't pass get explicitly nulled so the OS won't show dead buttons.
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
      /* some browsers throw on unsupported actions — safe to ignore */
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
// Leave / cleanup
// -----------------------------------------------------------------------------
async function leaveRoom() {
  try {
    await state.room?.disconnect();
  } finally {
    state.publishedTrack?.stop();
    state.hostAudioEl?.pause();
    state.listenerAudioEl?.pause();
    state.playlist.forEach((p) => URL.revokeObjectURL(p.url)); // free memory
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    }
    location.reload();
  }
}

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------
function fmt(sec: number) {
  if (!isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str: string) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
