/**
 * vite.config.ts — dev server for the React example.
 *
 * Two things worth copying into a real app, and one thing that is not:
 *
 *   proxy   /api/stream is a normal POST; /stream/<token> is the WebSocket, so
 *           it needs `ws: true`. Both go to the streamRtsp() server on :8080.
 *           Without the proxy the player would open its socket against Vite's
 *           origin (it derives the URL from location.host) and get a 404.
 *
 *   alias   ONLY because this example lives inside the repo and the package is
 *           not installed here. In your own app just `npm i rtsp-streamer` and
 *           import "rtsp-streamer/react" — delete this block.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "..", "dist");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "rtsp-streamer/react": path.join(dist, "react", "index.js"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/stream": { target: "ws://localhost:8080", ws: true },
    },
  },
});
