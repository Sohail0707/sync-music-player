import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    VitePWA({
      // Auto-update the service worker in the background and reload on next visit.
      registerType: 'autoUpdate',

      // We generate the manifest here (instead of a hand-written public/manifest.json)
      // so the plugin keeps the manifest, icons and SW in sync and injects the correct
      // <link rel="manifest"> tag into index.html automatically. This avoids the classic
      // "two competing manifests" bug.
      manifest: {
        name: 'Sync Music Player',
        short_name: 'SMP',
        description: 'SMP — listen to music together, perfectly in sync, with up to 30 friends.',
        theme_color: '#0c0a14',
        background_color: '#0c0a14',
        // standalone => no browser address bar; feels like a native app on iOS/Android.
        display: 'standalone',
        // Lock to portrait for a phone-first experience.
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          // "maskable" lets Android use adaptive icon shapes without clipping content.
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },

      workbox: {
        // Precache the built static assets (HTML/JS/CSS/icons) for instant loads + offline shell.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],

        // ALWAYS run the newest code: the moment a new service worker is built, activate it
        // immediately (skipWaiting), take control of open tabs (clientsClaim), and delete the
        // previous precache (cleanupOutdatedCaches). Combined with registerType:'autoUpdate',
        // visitors get the latest build on their next load — no "stuck on old version".
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,

        // CRITICAL: never let the service worker intercept real-time traffic.
        // LiveKit signalling runs over WebSockets (wss://) which Service Workers cannot
        // intercept anyway, but media/API calls over HTTP COULD be wrongly cached.
        // We explicitly bypass:
        //   - the LiveKit Cloud domain (signalling + TURN negotiation handshakes)
        //   - our own Netlify token function
        navigateFallbackDenylist: [/^\/\.netlify\//, /^\/api\//],
        runtimeCaching: [
          {
            // Never cache token requests — they are short-lived JWTs.
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/.netlify/functions/') || url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly'
          },
          {
            // Never cache anything talking to LiveKit Cloud.
            urlPattern: ({ url }) => url.hostname.endsWith('.livekit.cloud'),
            handler: 'NetworkOnly'
          }
        ]
      },

      devOptions: {
        // Keep the SW OFF during `vite dev` so local code changes are ALWAYS fresh
        // (no service worker caching to fight while developing). It's still generated
        // for production builds. Flip to true only when you specifically want to test
        // install/offline behaviour locally.
        enabled: false
      }
    })
  ],
  server: {
    host: true, // expose on LAN so you can test from a real phone over http://<your-ip>:5173
    port: 5173
  }
});
