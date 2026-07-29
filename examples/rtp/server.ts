/**
 * server.ts — RTP / MPEG-TS example.
 *
 * Unlike the other examples there is no camera to pull from — ffmpeg *pushes*
 * an MPEG-TS stream to us over RTP (or bare UDP), and streamRtp() demuxes it
 * into the same WebSocket wire format the <rtsp-player> already speaks.
 *
 *   POST /api/stream { "rtspUrl": "rtp://127.0.0.1:5004" } -> { path }
 *     rtp:// or udp:// -> streamRtp()   (ffmpeg push)
 *     rtsp://          -> streamRtsp()  (pull a camera, like the other examples)
 *
 * Run:
 *   npm run examples:rtp                     # this server on :8080
 * Then push a stream and open http://localhost:8080:
 *   ffmpeg -f dshow -i video="Integrated Camera":audio="Microphone Array (Realtek(R) Audio)" \
 *     -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v 2000k \
 *     -g 30 -c:a aac -b:a 128k -f rtp_mpegts rtp://127.0.0.1:5004
 * In the page, enter  rtp://127.0.0.1:5004  and press Play.
 *
 * (The `-g 30` above is not in the original command but makes video start in
 * ~1s instead of waiting up to ~8s for ffmpeg's default keyframe interval.)
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { streamRtsp, streamRtp, serveRtspPlayer } from "../../dist";

const HTTP_PORT = 8080;
const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");

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
  if (serveRtspPlayer(req, res)) return;

  /* ---------------------------- API ---------------------------------- */
  if (req.method === "POST" && req.url === "/api/stream") {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", () => {
      try {
        const { rtspUrl } = JSON.parse(body) as { rtspUrl?: string };
        const src = rtspUrl ?? "";
        const isRtp = /^(rtp|udp):\/\//i.test(src);
        const isRtsp = /^rtsp:\/\//i.test(src);
        if (!isRtp && !isRtsp) {
          json(res, 400, {
            error: "a rtsp://, rtp:// or udp:// URL is required",
          });
          return;
        }
        const wsPath = isRtp
          ? streamRtp(server, src)
          : streamRtsp(server, src);
        console.log(`[api] ${src} -> ${wsPath}`);
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
  console.log(`[rtp] open http://localhost:${HTTP_PORT}`),
);
