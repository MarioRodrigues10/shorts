import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built into ../static/app and served by server.py at http://127.0.0.1:7377
// `bun run dev` gives hot reload on :5173 with API calls proxied to the server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/static/app/",
  build: { outDir: "../static/app", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:7377", "/media": "http://127.0.0.1:7377", "/static/fonts": "http://127.0.0.1:7377" },
  },
});
