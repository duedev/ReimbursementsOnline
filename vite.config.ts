import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Static, client-side-only app. `base: "./"` keeps every asset reference
// relative so the same build works whether it is served from a domain root
// (Netlify/Vercel) or a project subpath (GitHub Pages) — no config needed.
export default defineConfig({
  base: "./",
  build: {
    target: "es2021",
    // The Tesseract OCR core is a ~3.4 MB wasm payload; let Workbox precache it
    // so the app works fully offline after the first visit.
    chunkSizeWarningLimit: 6000,
  },
  worker: {
    format: "es",
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "Reimbursements Online",
        short_name: "Reimburse",
        description:
          "Turn a pile of receipts into a polished reimbursement spreadsheet — in your browser, for free.",
        theme_color: "#0f766e",
        background_color: "#0b1120",
        display: "standalone",
        orientation: "portrait",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // App chunks (exceljs, pdf.js) can exceed the 2 MB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Precache the small app shell only; the multi-MB OCR cores and the
        // language data are runtime-cached on first use (keeps install light).
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,webmanifest}"],
        globIgnores: ["**/vendor/**"],
        runtimeCaching: [
          {
            // Same-origin Tesseract worker, wasm cores, and language data:
            // cache on first OCR so every later (and offline) run is free.
            urlPattern: ({ url }) => url.pathname.includes("/vendor/"),
            handler: "CacheFirst",
            options: {
              cacheName: "tesseract-assets",
              expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OCR language data is fetched on first use; cache it forever.
            urlPattern: /^https:\/\/tessdata\.projectnaptha\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "tesseract-langdata",
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});
