# rtsp-streamer

Stream an RTSP camera to the browser over WebSocket, with **zero runtime
dependencies** — no `ffmpeg`, no native addons, no external media server. The
package speaks RTSP/RTP directly (interleaved over TCP), forwards H.264 access
units to browsers, and ships a `<rtsp-player>` custom element that decodes them
with [WebCodecs](https://developer.mozilla.org/docs/Web/API/WebCodecs_API).

```
RTSP camera ──TCP──▶ streamRtsp() ──WebSocket──▶ <rtsp-player> ──WebCodecs──▶ <canvas>
```

## Features

- **Zero dependencies.** Only Node's built-in `net`/`crypto`/`http`.
- **Any HTTP server.** Works with the raw `http` module, Express, Fastify, or
  NestJS — you hand it the underlying `http.Server`.
- **Connection sharing.** One camera connection per unique RTSP URL, fanned out
  to every viewer; each `streamRtsp()` call returns a fresh access token.
- **Instant start.** New viewers immediately receive the last cached keyframe,
  so video appears without waiting for the camera's next IDR.
- **Basic & Digest auth**, automatic reconnect, and idle teardown (a session
  with no viewers for 60s disconnects from the camera).
- **Batteries-included client.** The `<rtsp-player>` element is served straight
  from the package at `/rtsp-player.js` — no copy step, no bundler.
- **Dual CJS + ESM** builds with full TypeScript types.

## Install

```bash
npm install rtsp-streamer
```

**Requirements**

- **Server:** Node.js 18+.
- **Browser:** a WebCodecs-capable browser (Chrome/Edge 94+, Safari 16.4+).
- **Camera:** an H.264 (AVC) RTSP stream. HEVC/H.265 and audio are not
  decoded — the transport is video-only today.

## Quick start

### Server

Call `streamRtsp(server, rtspUrl)` to mint a token-protected WebSocket path, and
`serveRtspPlayer(req, res)` to serve the browser element. `streamRtsp()` also
attaches the WebSocket `upgrade` handler and starts serving `/rtsp-player.js`
automatically the first time it runs.

```ts
import * as http from "node:http";
import { streamRtsp, serveRtspPlayer } from "rtsp-streamer";

const server = http.createServer((req, res) => {
  // Serve the <rtsp-player> element at /rtsp-player.js (before your routes).
  if (serveRtspPlayer(req, res)) return;

  // Mint a stream for a camera URL the client asks for.
  if (req.method === "POST" && req.url === "/api/stream") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { rtspUrl } = JSON.parse(body);
      const path = streamRtsp(server, rtspUrl); // -> "/stream/<token>"
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path }));
    });
    return;
  }

  // ...serve your own HTML/assets here...
});

server.listen(8080);
```

### Browser

Load the element and point it at a stream. The element POSTs the RTSP URL to
your server (`/api/stream` by default), opens the returned WebSocket, and paints
frames onto an internal `<canvas>`.

```html
<script type="module" src="/rtsp-player.js"></script>

<rtsp-player
  src="rtsp://user:pass@192.168.1.10:554/stream1"
  width="960"
  autoplay
  muted
></rtsp-player>
```

Or drive it from JavaScript:

```js
const player = document.querySelector("rtsp-player");

await player.play("rtsp://user:pass@cam/stream1");
player.stop();

player.addEventListener("playing", () => console.log("live"));
player.addEventListener("error", (e) => console.error(e.detail.message));
```

## Server API

### `streamRtsp(server, rtspUrl): string`

Starts (or reuses) an RTSP session for `rtspUrl` and exposes it on `server` as a
token-protected WebSocket endpoint. Returns the path, e.g.
`"/stream/6bd1…e2"`. Multiple calls with the same URL share one camera
connection but each returns a distinct token.

The first call on a given `server` also:

- attaches a single `upgrade` handler for the `/stream/<token>` WebSocket, and
- wraps the server's request listener so `/rtsp-player.js` is served before your
  own routes.

> Call `streamRtsp()` **after** your routes/handler are attached to the server,
> so they are captured by the request wrapper.

### `serveRtspPlayer(req, res, mountPath?): boolean`

Serves the bundled `<rtsp-player>` element (and its source map) for a plain
`http.IncomingMessage`. Returns `true` if it handled the request — a `GET`/`HEAD`
for `mountPath` (default `/rtsp-player.js`) or `mountPath + ".map"` — so you can
fall through to your own routing:

```ts
if (serveRtspPlayer(req, res)) return;
```

Because `streamRtsp()` only wires this up on its first call (typically the first
`/api/stream` request), call `serveRtspPlayer()` yourself in your request
pipeline so the script is available on the very first page load.

### Wire format

Each WebSocket binary message is a 1-byte keyframe flag followed by one Annex-B
H.264 access unit:

```
[1 byte: 1 = key, 0 = delta][00 00 00 01 ...NAL units...]
```

You only need this if you are writing your own client instead of using
`<rtsp-player>`.

## The `<rtsp-player>` element

A dependency-free custom element (shadow DOM, internal `<canvas>` and status
overlay). Import it as a module — it registers `rtsp-player` on load.

### Attributes

All attributes are reflected as properties (`player.src`, `player.autoplay`, …).

| Attribute  | Type    | Default       | Description                                            |
| ---------- | ------- | ------------- | ------------------------------------------------------ |
| `src`      | string  | —             | RTSP URL to play (`rtsp://…`).                         |
| `width`    | string  | —             | CSS width of the video surface (px if unitless).       |
| `height`   | string  | —             | CSS height of the video surface (px if unitless).      |
| `autoplay` | boolean | `false`       | Play as soon as the element connects or `src` changes. |
| `muted`    | boolean | `false`       | Present for `<video>` parity; transport is video-only. |
| `api`      | string  | `/api/stream` | Endpoint that mints a stream token from an `rtspUrl`.  |

### Methods

- **`play(src?)`** — resolve a token, open the WebSocket, and start decoding.
  Passing a URL adopts it into `src`. Resolves once the socket is open (frames
  arrive asynchronously after).
- **`stop()`** — close the socket and decoder and blank the canvas.

### Properties (read-only)

- **`state`** — `"idle" | "connecting" | "waiting" | "playing" | "error"`.
- **`playing`** — `true` while in the `playing` state.

### Events

| Event         | `detail`              | Fires when…                          |
| ------------- | --------------------- | ------------------------------------ |
| `playing`     | —                     | the first frame is decoding.         |
| `stopped`     | —                     | playback stops or the socket closes. |
| `error`       | `{ message: string }` | a request/socket/decode error.       |
| `statechange` | `{ state }`           | `state` transitions.                 |

The element expects your server to answer its `api` endpoint with the shape
`streamRtsp()` produces:

```
POST /api/stream  { "rtspUrl": "rtsp://…" }  ->  { "path": "/stream/<token>" }
```

## Framework examples

Runnable servers for the raw `http` module, Express, Fastify, and NestJS live in
[`examples/`](./examples). Each hands its underlying `http.Server` to
`streamRtsp()` and serves the demo page from `examples/public`.

```bash
npm run examples:http      # plain node:http
npm run examples:express   # Express
npm run examples:fastify   # Fastify
npm run examples:nest      # NestJS
```

Then open <http://localhost:8080>, paste an RTSP URL, and press **Play**.

The key detail across frameworks: the WebSocket `upgrade` is handled on the raw
`http.Server`, so build the server explicitly (e.g. `http.createServer(app)` for
Express, `app.server` for Fastify, `app.getHttpServer()` for Nest) and pass
_that_ to `streamRtsp()` — the framework keeps ownership of ordinary routes.

## Module formats

The package ships both CommonJS and ES modules with type declarations, resolved
via the `exports` map:

```js
const { streamRtsp } = require("rtsp-streamer"); // CommonJS -> dist/index.js
import { streamRtsp } from "rtsp-streamer"; //        ESM -> dist/esm/index.js
```

The compiled `<rtsp-player>` element is also available as a subpath import if you
prefer to bundle it yourself instead of serving it via `serveRtspPlayer()`:

```js
import "rtsp-streamer/html"; // registers <rtsp-player>
```

## Local testing

No camera handy? Publish your webcam as an RTSP stream with
[MediaMTX](https://github.com/bluenviron/mediamtx) and `ffmpeg`, then point the
player at `rtsp://localhost:8554/webcam`.

Start the RTSP server:

```bash
mediamtx
```

Publish the webcam (Windows / DirectShow — adjust the device name for your OS):

```bash
ffmpeg -f dshow -i video="Integrated Camera" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -f rtsp rtsp://localhost:8554/webcam
```

Lower latency and reduced input buffering:

```bash
ffmpeg -f dshow -rtbufsize 256M -vcodec mjpeg -i video="Integrated Camera" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -f rtsp rtsp://localhost:8554/webcam
```

For Audio support in windows, use the following command:

`ffmpeg -f dshow -i video="Integrated Camera":audio="Microphone Array (Realtek(R) Audio)" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 2000k -c:a aac -b:a 128k -f rtsp rtsp://localhost:8554/webcam`

## Development

```bash
npm run build        # build:html + inline asset, then CJS and ESM
npm run typecheck    # type-check every project (Node + browser)
npm run lint         # ESLint
npm run format       # Prettier --write
```

`src/index.ts` is the Node library; `src/html/rtsp-player.ts` is the browser
element (compiled with DOM/WebCodecs types via `tsconfig.html.json` and inlined
into the library by `scripts/build-assets.mjs`).

## License

ISC
