/**
 * server.ts — the Next.js custom server, run by tsx.
 *
 * Next's App Router route handlers can't answer a WebSocket upgrade (they have
 * no access to the http.Server or the raw socket), so streamRtsp() can't be
 * wired from inside one. A custom server owns the http.Server, so here we:
 *
 *   1. create the http.Server and give it Next's request handler, and
 *   2. registerRtspBridge(...) so app/api/stream/route.ts can mint tokens with
 *      streamRtsp() bound to *this* server — which is also where streamRtsp()
 *      attaches the /stream/<token> WebSocket upgrade handler.
 *
 * Run:  npm run dev   (from examples/next)  ->  http://localhost:3000
 */

import { createServer } from "node:http";
import next from "next";
import { streamRtsp } from "rtsp-streamer";
import { registerRtspBridge } from "rtsp-streamer/next";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev });
const handle = app.getRequestHandler();

async function main(): Promise<void> {
  await app.prepare();

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  // streamRtsp(server, url) mints "/stream/<token>" and (on its first call)
  // attaches the upgrade handler for it to this same server.
  registerRtspBridge((rtspUrl) => streamRtsp(server, rtspUrl));

  server.listen(port, () => {
    console.log(`[next] http://localhost:${port}`);
  });
}

void main();
