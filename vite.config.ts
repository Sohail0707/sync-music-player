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
        name: 'Sync Music Party',
        short_name: 'SyncParty',
        description: 'Listen to music together, perfectly in sync, with up to 30 friends.',
        theme_color: '#0f0f14',
        background_color: '#0f0f14',
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
        // Enable the SW in `vite dev` so you can test install/background behaviour locally.
        enabled: true
      }
    })
  ],
  server: {
    host: true, // expose on LAN so you can test from a real phone over http://<your-ip>:5173
    port: 5173
  }
});
