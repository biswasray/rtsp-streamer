/**
 * server.ts — Example server using the streamRTSP module.
 *
 *   POST /api/stream  { "rtspUrl": "rtsp://user:pass@cam/stream1" }
 *     -> { "path": "/stream/<token>" }
 *
 * Also serves the browser client from ./public (index.html, client.js).
 *
 * Run:
 *   Node >= 23.6:   node server.ts
 *   Node 22.6+:     node --experimental-strip-types server.ts
 * Then open http://localhost:8080
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { streamRTSP } from "../../src";

const HTTP_PORT = 8080;
const PUBLIC_DIR = path.join(import.meta.dirname, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function json(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  /* ---------------------------- API ---------------------------------- */
  if (req.method === "POST" && req.url === "/api/stream") {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
      if (body.length > 4096) req.destroy(); // tiny request expected
    });
    req.on("end", () => {
      try {
        const { rtspUrl } = JSON.parse(body) as { rtspUrl?: string };
        if (!rtspUrl || !/^rtsp:\/\//i.test(rtspUrl)) {
          json(res, 400, { error: "rtspUrl (rtsp://…) is required" });
          return;
        }
        const wsPath = streamRTSP(server, rtspUrl);
        console.log(
          `[api] ${rtspUrl.replace(/\/\/.*@/, "//***@")} -> ${wsPath}`,
        );
        json(res, 200, { path: wsPath });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
    });
    return;
  }

  /* ------------------------- static files ----------------------------- */
  const urlPath = req.url === "/" ? "/index.html" : (req.url ?? "/");
  const file = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!file.startsWith(PUBLIC_DIR)) {
    // block path traversal
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(data);
  });
});

server.listen(HTTP_PORT, () =>
  console.log(`[http] open http://localhost:${HTTP_PORT}`),
);
