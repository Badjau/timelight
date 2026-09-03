import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import packageJson from './package.json';

export default defineConfig({
  base: '/timelight/',
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'TimeLight',
        short_name: 'TimeLight',
        description: 'A clear visual timing system for speakers and events.',
        start_url: '/timelight/',
        scope: '/timelight/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#08111f',
        background_color: '#08111f',
        icons: [
          {
            src: 'pwa-192x192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'pwa-512x512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'pwa-512x512-maskable.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The app has no API. Workbox precaches the complete generated shell;
        // intentionally do not add runtime network caching.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
