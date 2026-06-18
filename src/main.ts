// src/main.ts
// -----------------------------------------------------------------------------
// Sync Music Party — single-file app logic.
//
//  Host    : picks a local audio file -> routes it through Web Audio ->
//            publishes the resulting MediaStreamTrack to LiveKit.
//  Listener: subscribes to the host's track -> waits for a user TAP ->
//            attaches the track to an <audio> element and plays it.
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

import './style.css';

// In dev (vite) we call the Netlify function via `netlify dev` proxy or the live site.
// The `/api/get-token` alias is defined in netlify.toml.
const TOKEN_ENDPOINT = '/api/get-token';

// -----------------------------------------------------------------------------
// Tiny DOM helper
// -----------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

// -----------------------------------------------------------------------------
// App state
// -----------------------------------------------------------------------------
interface AppState {
  room: Room | null;
  isHost: boolean;
  // Host-only audio graph pieces:
  audioCtx: AudioContext | null;
  hostAudioEl: HTMLAudioElement | null;
  publishedTrack: LocalAudioTrack | null;
  isPlaying: boolean;
  // Listener-only:
  listenerAudioEl: HTMLAudioElement | null;
  pendingRemoteTrack: RemoteTrack | null;
}

const state: AppState = {
  room: null,
  isHost: false,
  audioCtx: null,
  hostAudioEl: null,
  publishedTrack: null,
  isPlaying: false,
  listenerAudioEl: null,
  pendingRemoteTrack: null
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
      <span id="statusDot" class="status disconnected" title="connection"></span>
    </header>

    <!-- HOST controls -->
    <section id="hostPanel" hidden>
      <h2>Host controls</h2>
      <label class="field">
        <span>Choose an audio file</span>
        <input id="fileInput" type="file" accept="audio/*" />
      </label>
      <p id="trackName" class="track-name">No file loaded</p>
      <div class="transport">
        <button id="playBtn" class="primary" disabled>▶ Play</button>
        <button id="pauseBtn" disabled>⏸ Pause</button>
      </div>
      <p class="hint">Listeners hear exactly what you play here. Keep this tab open.</p>
    </section>

    <!-- LISTENER view -->
    <section id="listenerPanel" hidden>
      <h2>Live stream</h2>
      <p id="listenerStatus" class="listener-status">Waiting for the host to start…</p>
      <div class="now-playing">
        <div class="vinyl" id="vinyl">💿</div>
        <p>Live Sync Party</p>
        <small>Host Stream</small>
      </div>
    </section>

    <button id="leaveBtn" class="ghost">Leave room</button>
  </main>

  <!-- CRITICAL mobile-autoplay unlock overlay (listeners) -->
  <div id="unmuteOverlay" class="overlay" hidden>
    <div class="overlay-card">
      <h2>🔊 Stream is live</h2>
      <p>Mobile browsers block audio until you tap. One tap and you're in.</p>
      <button id="unmuteBtn" class="primary big">Tap to Unmute &amp; Connect to Live Stream</button>
    </div>
  </div>
`;

// -----------------------------------------------------------------------------
// Landing screen wiring
// -----------------------------------------------------------------------------
const enterBtn = $<HTMLButtonElement>('#enterBtn');

enterBtn.addEventListener('click', async () => {
  const roomName = $<HTMLInputElement>('#roomInput').value.trim();
  const participantName = $<HTMLInputElement>('#nameInput').value.trim();
  const isHost = $<HTMLInputElement>('#hostCheckbox').checked;
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
    // IMPORTANT (iOS): the AudioContext / first audio interaction must be created
    // inside a user gesture. The "Enter Room" click IS that gesture, so we create
    // the host's AudioContext here (it stays suspended until play).
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
});

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

  const room = new Room({
    // Audio-only party: we don't need adaptive video.
    adaptiveStream: false,
    dynacast: true
  });
  state.room = room;

  // Connection status UI.
  const dot = $('#statusDot');
  room
    .on(RoomEvent.Connected, () => dot.className = 'status connected')
    .on(RoomEvent.Reconnecting, () => dot.className = 'status reconnecting')
    .on(RoomEvent.Reconnected, () => dot.className = 'status connected')
    .on(RoomEvent.Disconnected, () => dot.className = 'status disconnected');

  if (!isHost) {
    wireListenerEvents(room);
  }

  await room.connect(url, token);

  // Swap screens.
  $('#landing').hidden = true;
  $('#room').hidden = false;
  $('#roomLabel').textContent = `#${roomName}`;
  $('#roleBadge').textContent = isHost ? 'HOST' : 'LISTENER';
  $('#roleBadge').classList.toggle('host', isHost);

  if (isHost) {
    $('#hostPanel').hidden = false;
    setupHost();
  } else {
    $('#listenerPanel').hidden = false;
  }

  $<HTMLButtonElement>('#leaveBtn').addEventListener('click', () => leaveRoom());
}

// -----------------------------------------------------------------------------
// HOST: file -> Web Audio graph -> LiveKit publish
// -----------------------------------------------------------------------------
function setupHost() {
  // Hidden <audio> element the host actually "plays". We DON'T attach it to the DOM
  // for visuals — the host hears sound through the Web Audio graph below.
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  audioEl.preload = 'auto';
  state.hostAudioEl = audioEl;

  const fileInput = $<HTMLInputElement>('#fileInput');
  const playBtn = $<HTMLButtonElement>('#playBtn');
  const pauseBtn = $<HTMLButtonElement>('#pauseBtn');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    // Object URL keeps the file fully local — nothing is uploaded; only the decoded
    // audio is streamed out as a WebRTC track.
    audioEl.src = URL.createObjectURL(file);
    $('#trackName').textContent = file.name;
    playBtn.disabled = false;

    // Keep the lock-screen / notification metadata fresh.
    updateMediaMetadata(file.name, 'Live Sync Party');
  });

  playBtn.addEventListener('click', async () => {
    await startBroadcast();
  });

  pauseBtn.addEventListener('click', () => {
    audioEl.pause();
  });

  // Reflect element state -> UI + Media Session playback state.
  audioEl.addEventListener('play', () => {
    state.isPlaying = true;
    playBtn.disabled = true;
    pauseBtn.disabled = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  audioEl.addEventListener('pause', () => {
    state.isPlaying = false;
    playBtn.disabled = false;
    pauseBtn.disabled = true;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });

  // Wire Media Session so the OS shows transport controls AND keeps our thread alive.
  setupMediaSession(
    () => audioEl.play(),
    () => audioEl.pause()
  );
}

async function startBroadcast() {
  const room = state.room!;
  const audioEl = state.hostAudioEl!;
  const ctx = state.audioCtx!;

  // iOS suspends AudioContexts created outside a gesture; resume inside this click.
  if (ctx.state === 'suspended') await ctx.resume();

  // ---------------------------------------------------------------------------
  // Build the capture graph ONCE.
  //
  // Why Web Audio + MediaStreamDestination instead of audioEl.captureStream()?
  //   - audioEl.captureStream() is NOT supported on iOS Safari and is flaky across
  //     browsers. Routing through an AudioContext is the portable, reliable path.
  //   - We split the signal: -> ctx.destination (host hears it locally)
  //                          -> MediaStreamAudioDestinationNode (the WebRTC track)
  // ---------------------------------------------------------------------------
  if (!state.publishedTrack) {
    // createMediaElementSource can only be called ONCE per element; guard with the flag.
    const sourceNode = ctx.createMediaElementSource(audioEl);
    const streamDest = ctx.createMediaStreamDestination();

    sourceNode.connect(ctx.destination); // local monitoring (host's own speakers)
    sourceNode.connect(streamDest); // the stream we broadcast

    const [mediaStreamTrack] = streamDest.stream.getAudioTracks();

    // Publish the raw MediaStreamTrack to LiveKit. We disable audio processing
    // (echo cancellation / noise suppression / AGC) because this is MUSIC, not a
    // voice call — those filters would wreck the sound quality.
    const pub = await room.localParticipant.publishTrack(mediaStreamTrack, {
      name: 'music',
      source: Track.Source.Microphone, // treated as a normal audio source by clients
      dtx: false, // never use discontinuous transmission for music
      red: true, // redundant encoding -> resilience to packet loss
      stopMicTrackOnMute: false
    });
    state.publishedTrack = pub.audioTrack as LocalAudioTrack;
  }

  // Fallback path if you ever want native captureStream on a supported browser:
  //   const stream = (audioEl as any).captureStream?.() ?? (audioEl as any).mozCaptureStream?.();
  //   await room.localParticipant.publishTrack(stream.getAudioTracks()[0]);

  await audioEl.play();
}

// -----------------------------------------------------------------------------
// LISTENER: subscribe -> wait for tap -> attach + play
// -----------------------------------------------------------------------------
function wireListenerEvents(room: Room) {
  // A dedicated <audio> element we control directly (so Media Session can drive it).
  const audioEl = new Audio();
  audioEl.autoplay = false; // NEVER autoplay — mobile will silently block it.
  state.listenerAudioEl = audioEl;

  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, _pub: RemoteTrackPublication, _participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;

      // Stash the track and show the unlock overlay. We deliberately DO NOT attach +
      // play here — without a user gesture iOS Safari / Android Chrome reject play().
      state.pendingRemoteTrack = track;
      $('#listenerStatus').textContent = 'Host is live!';
      showUnmuteOverlay();
    }
  );

  room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    track.detach();
    state.pendingRemoteTrack = null;
    $('#listenerStatus').textContent = 'Host paused or left. Waiting…';
    $('#vinyl').classList.remove('spinning');
  });

  // Unmute button = the required user gesture.
  $<HTMLButtonElement>('#unmuteBtn').addEventListener('click', async () => {
    const track = state.pendingRemoteTrack;
    if (!track) {
      hideUnmuteOverlay();
      return;
    }

    // Attach the live WebRTC track to our <audio> element, then play() — this whole
    // sequence runs INSIDE the click handler, satisfying the autoplay-gesture rule.
    track.attach(audioEl);
    try {
      await audioEl.play();
    } catch (e) {
      console.error('play() rejected even after gesture:', e);
    }

    // Media Session lets playback continue when the screen locks / app backgrounds.
    updateMediaMetadata('Live Sync Party', 'Host Stream');
    setupMediaSession(
      () => audioEl.play(),
      () => audioEl.pause()
    );
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';

    $('#vinyl').classList.add('spinning');
    $('#listenerStatus').textContent = '🔴 Listening live';
    hideUnmuteOverlay();
  });
}

function showUnmuteOverlay() {
  $('#unmuteOverlay').hidden = false;
}
function hideUnmuteOverlay() {
  $('#unmuteOverlay').hidden = true;
}

// -----------------------------------------------------------------------------
// MEDIA SESSION API — the background-playback workaround (Host AND Listener)
// -----------------------------------------------------------------------------
//
// Why this matters:
//   When the screen locks or the PWA is backgrounded, mobile OSes aggressively
//   suspend "silent" tabs to save battery. By registering Media Session metadata
//   AND action handlers, we signal to iOS Safari / Android Chrome that this tab is
//   an active *media* session (like a music app). The OS then:
//     - shows lock-screen / notification transport controls, and
//     - keeps the audio thread running in the background instead of pausing it.
//
//   The action handlers MUST be present (even if minimal) — an empty/absent handler
//   set is what causes the OS to reclaim the media focus and stop the audio.
// -----------------------------------------------------------------------------
function setupMediaSession(onPlay: () => void, onPause: () => void) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.setActionHandler('play', () => {
    onPlay();
    navigator.mediaSession.playbackState = 'playing';
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    onPause();
    navigator.mediaSession.playbackState = 'paused';
  });

  // Explicitly null out controls we don't support so the OS doesn't show dead buttons
  // (and doesn't think the session is misbehaving).
  for (const action of ['seekbackward', 'seekforward', 'previoustrack', 'nexttrack'] as const) {
    try {
      navigator.mediaSession.setActionHandler(action, null);
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
    // Artwork shows on the lock screen. Reuse the PWA icon.
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
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    }
    // Simplest reliable reset for a single-page flow.
    location.reload();
  }
}
