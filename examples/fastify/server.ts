/**
 * server.ts — Fastify equivalent of the plain-http example.
 *
 *   POST /api/stream  { "rtspUrl": "rtsp://user:pass@cam/stream1" }
 *     -> { "path": "/stream/<token>" }
 *
 * Serves the same browser client as the other examples (../public).
 *
 * The WebSocket upgrade is handled by streamRTSP() on the underlying
 * http.Server. Fastify creates and owns that server, exposed as
 * `app.server`, so that is what we hand to streamRTSP — Fastify keeps
 * ownership of the ordinary HTTP routes.
 *
 * Run:
 *   npm run examples:fastify
 * Then open http://localhost:8080
 */

import * as path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { streamRTSP, serveRtspPlayer } from "../../dist";

const HTTP_PORT = 8080;
const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");

const app = Fastify({ bodyLimit: 4096 }); // tiny requests expected

/* ------------------- bundled <rtsp-player> element -------------------- */
// Serve /rtsp-player.js from the package's dist/html (no copy step). We write
// to the raw response and hijack so Fastify leaves the reply alone.
app.addHook("onRequest", (req, reply, done) => {
  if (serveRtspPlayer(req.raw, reply.raw)) reply.hijack();
  else done();
});

/* ------------------------- static files ------------------------------- */
app.register(fastifyStatic, { root: PUBLIC_DIR }); // serves index.html at "/"

/* ---------------------------- API ------------------------------------ */
app.post("/api/stream", (req, reply) => {
  const { rtspUrl } = (req.body ?? {}) as { rtspUrl?: string };
  if (!rtspUrl || !/^rtsp:\/\//i.test(rtspUrl)) {
    return reply.code(400).send({ error: "rtspUrl (rtsp://…) is required" });
  }
  try {
    const wsPath = streamRTSP(app.server, rtspUrl);
    console.log(`[api] ${rtspUrl.replace(/\/\/.*@/, "//***@")} -> ${wsPath}`);
    return reply.send({ path: wsPath });
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.listen({ port: HTTP_PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[fastify] open http://localhost:${HTTP_PORT}`);
});
