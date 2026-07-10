/**
 * server.ts — Express equivalent of the plain-http example.
 *
 *   POST /api/stream  { "rtspUrl": "rtsp://user:pass@cam/stream1" }
 *     -> { "path": "/stream/<token>" }
 *
 * Serves the same browser client as the http example (../http/public).
 *
 * The WebSocket upgrade is handled by streamRTSP() on the underlying
 * http.Server, so we build the server with http.createServer(app) and
 * hand *that* to streamRTSP — Express only owns the ordinary HTTP routes.
 *
 * Run:
 *   npm run examples:express
 * Then open http://localhost:8080
 */

import * as http from "node:http";
import * as path from "node:path";
import express from "express";
import { streamRTSP } from "../../dist";

const HTTP_PORT = 8080;
const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "4kb" })); // tiny requests expected

/* ---------------------------- API ------------------------------------ */
app.post("/api/stream", (req, res) => {
  const { rtspUrl } = req.body as { rtspUrl?: string };
  if (!rtspUrl || !/^rtsp:\/\//i.test(rtspUrl)) {
    res.status(400).json({ error: "rtspUrl (rtsp://…) is required" });
    return;
  }
  try {
    const wsPath = streamRTSP(server, rtspUrl);
    console.log(`[api] ${rtspUrl.replace(/\/\/.*@/, "//***@")} -> ${wsPath}`);
    res.json({ path: wsPath });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/* ------------------------- static files ------------------------------- */
app.use(express.static(PUBLIC_DIR)); // serves index.html at "/"

server.listen(HTTP_PORT, () =>
  console.log(`[express] open http://localhost:${HTTP_PORT}`),
);
