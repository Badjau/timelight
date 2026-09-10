import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/timelight/',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        transcription: 'admin/transcription/index.html',
      },
    },
  },
  plugins: [
    VitePWA({
      // Activate each deployed release as soon as the browser discovers it.
      // The generated client reloads controlled tabs once, so nobody needs to
      // bypass the service-worker cache manually with Ctrl+F5.
      registerType: 'autoUpdate',
      manifest: {
        name: 'TimeLight',
        short_name: 'TimeLight',
        id: '/timelight/',
        description: 'A clear visual timing system for speakers and events.',
        start_url: '/timelight/',
        scope: '/timelight/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#08111f',
        background_color: '#08111f',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'pwa-512x512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The app has no API. Workbox precaches the complete generated shell;
        // intentionally do not add runtime network caching.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: 'index.html',
        navigateFallbackAllowlist: [/^\/timelight\//],
      },
    }),
  ],
});
