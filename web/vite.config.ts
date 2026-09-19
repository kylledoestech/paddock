import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Build id shown on the home screen, e.g. "0919.1342" (month-day.hour-minute, local time).
// The same id is written to /version.json, which the app polls to spot a newer build.
const now = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const BUILD_ID = `${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`

const versionFile = (): Plugin => ({
  name: 'orca-version-file',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
  },
})

export default defineConfig({
  // Fonts stay separate files (cached once) instead of being inlined into the CSS as base64.
  // Preact's React-compatible layer: same API, a fraction of react-dom's size on the phone.
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom/client': 'preact/compat/client',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
    },
  },
  build: { assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined) },
  define: { __ORCA_BUILD__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    versionFile(),
    VitePWA({
      registerType: 'autoUpdate',
      // Own service worker (src/sw.ts): precaching plus push notifications.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'Orca',
        short_name: 'Orca',
        description: 'Drive your herdr agents from your phone',
        theme_color: '#0E0F11',
        background_color: '#0E0F11',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    host: true,
    // Dev only: forward API and sockets to the bridge (bridge/src/server.ts).
    proxy: {
      '/api': 'http://127.0.0.1:4280',
      '/ws': { target: 'ws://127.0.0.1:4280', ws: true },
    },
  },
})
