# 🎧 Sync Music Player (SMP)

A "serverless DJ" — pick a party, and everyone hears the same playlist **in sync**, on their
own device. Built for phones (iOS Safari + Android Chrome), installable as a PWA.

## How it works (server-anchored shared timeline)

Nothing is streamed. Songs live in cloud storage; every device downloads and plays its
**own local copy**. Playback position is a **pure function of a shared server clock and a
small schedule anchor** — so no device has to coordinate in real time:

```
schedule = { trackKey, anchorPos, anchorServerTime, playing }   (stored server-side)
position = playing ? anchorPos + (serverNow − anchorServerTime) : anchorPos
```

- **Clock = the server** (`/api/time`), not the host → the host can sleep, background, or
  briefly drop without breaking anyone.
- **Schedule lives on the server** (Netlify Blobs) → late joiners and devices returning
  from background just re-read it.
- **Every device (host included) runs the same local "follow" loop**, self-correcting to
  the derived position. Only the host may *change* the schedule.
- **Cloudflare R2** stores the audio (presigned downloads). **LiveKit** is used only for
  instant push of schedule changes + presence + admission — never for timing.

Why this design (it fixes everything live-streaming couldn't on iOS):
- **iPhone can host** — plays a normal `<audio>` element, no Web Audio capture.
- **Background playback works** for host *and* listeners.
- **~Zero latency** — playback is local; only a clock signal crosses the network.
- **Full audio quality** — original files, not re-encoded.
- **LiveKit bandwidth is trivial** — it only carries small JSON messages.

## Stack
- Vite + vanilla TypeScript, PWA (`vite-plugin-pwa`)
- **LiveKit Cloud** — realtime control/sync channel only
- **Cloudflare R2** — music file storage (S3-compatible, free egress)
- **Netlify Functions** — token, party list, playlist (presigned downloads), host uploads

## Setup

### 1. LiveKit Cloud
Create a project at <https://cloud.livekit.io>, copy API Key, Secret, and `wss://…` URL.

### 2. Cloudflare R2
Create a bucket, a CORS policy (GET/HEAD/PUT for your origins), and an S3 API token. See the
setup notes you followed — you need: account ID, access key, secret, bucket name, S3 endpoint.

### 3. Environment variables (Netlify + local `.env`)
```
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_URL=wss://your-project.livekit.cloud
SMP_HOST_PASSWORD=choose-a-strong-password      # only people with this can host
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=smp-music
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

> **Netlify Blobs** (used for the schedule) needs **no env vars or dashboard setup** — it's
> automatic on Netlify. For local testing, run `netlify link` once so `netlify dev` uses the
> right store.

### 4. Run locally
```bash
npm install
cp .env.example .env     # fill in the values above
npm install -g netlify-cli
netlify link             # once, so Netlify Blobs works locally
netlify dev              # serves the app + all /api functions
```
Test sync with **two browser windows/devices** (one host, one listener).

### 5. Deploy
Push to GitHub → import in Netlify (build settings come from `netlify.toml`) → add the env
vars → deploy. Optionally point `smp.yourdomain.com` at the site.

## Parties & playlists
- The 10 parties are defined in [`netlify/functions/_parties.js`](netlify/functions/_parties.js) — edit names there.
- Each party maps to an R2 prefix `parties/<id>/`. The **host uploads songs** (in-app, "Add songs"),
  which land in that prefix; listeners auto-refresh.
- Only someone with `SMP_HOST_PASSWORD` can host or upload.

## Usage
- **Host:** pick a party, tick "Host this party", enter the password, add songs, press play.
- **Listeners:** pick the same party (or scan the host's QR), tap "Listen in Sync".

## Swapping storage providers
All storage goes through [`netlify/functions/_r2.js`](netlify/functions/_r2.js). To move to
S3 / Backblaze / Supabase, rewrite just that file — the app is unchanged.

## Notes / limits
- iOS shows a CSS pulse instead of the audio-reactive visualizer, so background playback isn't
  broken by Web Audio (desktop/Android get the real spectrum bars).
- LiveKit free tier is plenty here (only tiny control messages). R2 free tier: 10 GB storage,
  free egress. Netlify legacy free: 100 GB bandwidth, 125k function calls.
- Hosting copyrighted files in cloud storage is your legal responsibility.
