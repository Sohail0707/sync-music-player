# 🎧 Sync Music Party

Synchronized, real-time music listening for 20–30 friends. A single **Host** streams a
local audio file to many **Listeners** over WebRTC (LiveKit Cloud), with **background /
lock-screen playback** on iOS Safari and Android Chrome.

- **Frontend:** Vite + vanilla TypeScript, installable PWA (`vite-plugin-pwa`)
- **Media server:** LiveKit Cloud (free tier)
- **Token auth:** Netlify serverless function (keys stay server-side)

> **Stack choice:** vanilla TypeScript over React. The app is one screen with two modes;
> React would add ~40 KB and a render layer for zero benefit here. The hard parts are the
> audio graph and Media Session lifecycle, not UI state.

---

## How it works

```
HOST                                          LISTENER (×30)
file -> <audio> -> Web Audio graph            LiveKit sub -> [TAP] -> track.attach(<audio>) -> play()
                 ├─> speakers (monitor)                                    │
                 └─> MediaStreamDestination                                └─> Media Session keeps it alive
                        -> publishTrack() ──► LiveKit Cloud ──► subscribe
```

### Two mobile gotchas this app solves

1. **Autoplay block** — mobile browsers refuse `audio.play()` without a user gesture.
   Listeners get a full-screen **"Tap to Unmute & Connect"** overlay; `track.attach()` +
   `play()` run *inside* that click. (`src/main.ts` → `wireListenerEvents`)
2. **Background suspension** — locked/backgrounded tabs get killed. The **Media Session
   API** with live metadata + `play`/`pause` action handlers tells the OS this is real
   media, so it keeps the audio thread alive and shows lock-screen controls.
   (`src/main.ts` → `setupMediaSession`)

> The host uses a **Web Audio `MediaStreamAudioDestinationNode`** rather than
> `audioElement.captureStream()` — `captureStream()` is unsupported on iOS Safari and
> flaky elsewhere. The portable approach is to route the element through an `AudioContext`.

---

## Setup

### 1. LiveKit Cloud
Create a free project at <https://cloud.livekit.io>, then copy from **Settings → Keys**:
`API Key`, `API Secret`, and your project URL (`wss://<project>.livekit.cloud`).

### 2. Local dev
```bash
npm install
cp .env.example .env        # fill in your 3 LiveKit values
npm install -g netlify-cli  # one-time, gives you the function proxy
netlify dev                 # serves the app AND /api/get-token together
```
Open the LAN URL it prints on your **phone** to test mobile behaviour (the SW needs
HTTPS or localhost — `netlify dev` localhost is fine; for a real phone use the deployed
site or a tunnel).

`npm run dev` alone runs the frontend only — the token endpoint won't exist.

### 3. Deploy to Netlify
1. Push to GitHub and "Import" the repo in Netlify (build settings come from `netlify.toml`).
2. In **Site settings → Environment variables**, add:
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`.
3. Deploy. Open the site on a phone and **Add to Home Screen** for fullscreen + best
   background-audio behaviour.

---

## Usage
- **Host:** check *"I am the Host"*, enter a room + nickname, pick an audio file, hit Play.
- **Listeners:** same room name, leave the Host box unchecked, then tap the unmute overlay.

## Files
| File | Purpose |
|------|---------|
| `netlify/functions/get-token.js` | Mints role-scoped LiveKit JWTs |
| `src/main.ts` | All app logic: connect, audio pipeline, Media Session |
| `vite.config.ts` | PWA manifest + service-worker rules (skips WS/API traffic) |
| `netlify.toml` | Build, functions, `/api/*` redirect, SPA fallback |
| `public/icons/*` | Placeholder PWA icons — **replace with your own art** |

## Free-tier notes
- LiveKit free tier covers this easily: 1 publisher + ~30 subscribers of a single mono/stereo
  music track is well within bandwidth/participant limits for casual use.
- Set music-friendly publish options are already applied (`dtx:false`, `red:true`, no AGC/NS).
