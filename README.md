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
- **RTP push, too.** `streamRtp()` receives an MPEG-TS stream pushed over
  RTP/UDP (e.g. `ffmpeg -f rtp_mpegts`), demuxes H.264 + AAC, and feeds the same
  player — no camera required.
- **Instant start.** New viewers immediately receive the last cached keyframe,
  so video appears without waiting for the camera's next IDR.
- **Audio.** AAC, G.711 (PCMU/PCMA) and Opus tracks are forwarded and played
  via WebCodecs + Web Audio; audio problems degrade to video-only, never a
  dead player.
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
- **Camera:** an H.264 (AVC) RTSP video stream — HEVC/H.265 is not decoded.
  Audio is forwarded when the camera offers AAC (`mpeg4-generic`), G.711
  (PCMU/PCMA) or Opus; other audio codecs are ignored.

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

### `streamRtp(server, url): string`

The **push** counterpart of `streamRtsp()`, for when a producer sends you an
MPEG-TS stream over RTP/UDP instead of you pulling from a camera. `url` is where
the library **listens** and the producer pushes to — `rtp://host:port` (RTP,
payload type 33) or `udp://host:port` (bare MPEG-TS). Returns the same
token-protected `/stream/<token>` path, consumed by the same `<rtsp-player>`.

```ts
const path = streamRtp(server, "rtp://127.0.0.1:5004");
```

Feed it from ffmpeg (H.264 video + AAC audio are demuxed; other codecs ignored):

```bash
ffmpeg -f dshow -i video="Integrated Camera":audio="Microphone Array (Realtek(R) Audio)" \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v 2000k \
  -g 30 -c:a aac -b:a 128k -f rtp_mpegts rtp://127.0.0.1:5004
```

`-g 30` keeps the keyframe interval short so video starts in ~1s; the stream
works without it too. See [`examples/rtp`](./examples/rtp) for a runnable server.

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

The first byte of each WebSocket binary message is the message type:

```
0  delta video   [Annex-B H.264 access unit]
1  key video     [Annex-B H.264 access unit]
2  audio config  [UTF-8 JSON: { codec, sampleRate, numberOfChannels,
                  description? (base64) } — a WebCodecs AudioDecoderConfig]
3  audio frame   [one encoded frame: raw AAC AU / G.711 bytes / Opus packet]
```

No cross-track timestamps are carried — it's a live view; both tracks are
forwarded as they arrive. You only need this if you are writing your own client
instead of using `<rtsp-player>`.

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
| `muted`    | boolean | `false`       | Mute audio output. Toggleable live, like `<video>`.    |
| `api`      | string  | `/api/stream` | Endpoint that mints a stream token from an `rtspUrl`.  |

Browsers keep audio suspended until a user gesture: starting playback from a
click works immediately, while `autoplay` streams stay silent until the first
pointer interaction (video is unaffected).

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

## React

The same player as a component, for apps that would rather not register a custom
element. React is an optional peer dependency; nothing else is added.

```jsx
import { RtspPlayer } from "rtsp-streamer/react";

<RtspPlayer src="rtsp://user:pass@cam/stream1" width={960} autoPlay muted />;
```

Props mirror the element's attributes — `src`, `width`, `height`, `autoPlay`,
`muted`, `api` — plus `className`, `style`, `hideStatus` (drop the built-in
status overlay) and `children` (rendered above the canvas). The element's events
become callbacks: `onPlaying`, `onStopped`, `onError(message)`,
`onStateChange(state)`. A `ref` exposes `play(src?)`, `stop()`, `state` and
`playing`.

For custom chrome, use the hook and render your own markup:

```jsx
import { useRtspPlayer } from "rtsp-streamer/react";

function Camera({ src }) {
  const { canvasRef, state, status, play, stop } = useRtspPlayer({ src });
  return (
    <>
      <canvas ref={canvasRef} />
      <button onClick={() => (state === "playing" ? stop() : play())}>
        {status}
      </button>
    </>
  );
}
```

`RtspEngine` — the framework-free core both of the above are built on (socket,
WebCodecs decoders, Web Audio; you supply the `<canvas>`) — is exported too.

## Angular

The same player as a standalone Angular component. Angular is an optional peer
dependency (`>=17`); nothing else is added.

```ts
import { Component } from "@angular/core";
import { RtspPlayerComponent } from "rtsp-streamer/angular";

@Component({
  standalone: true,
  imports: [RtspPlayerComponent],
  template: `
    <rtsp-player
      src="rtsp://user:pass@cam/stream1"
      [width]="960"
      autoPlay
      muted
    ></rtsp-player>
  `,
})
export class CameraComponent {}
```

Inputs mirror the element's attributes — `src`, `width`, `height`, `autoPlay`,
`muted`, `api`, plus `hideStatus` (drop the built-in status overlay). Projected
content (`<ng-content>`) renders above the canvas. The element's events become
`@Output()`s: `playing`, `stopped`, `error` (emits the message), `stateChange`
(emits the state). Grab the component with a template ref or `@ViewChild` for the
imperative `play(src?)` / `stop()` methods and the read-only `state`.

```ts
@ViewChild(RtspPlayerComponent) player!: RtspPlayerComponent;
// this.player.play("rtsp://user:pass@cam/stream1"); this.player.stop();
```

The component's selector is `rtsp-player` — the same tag as the bundled custom
element. Use one or the other in a given app, never both (don't also load
`/rtsp-player.js`). For custom chrome, import `RtspEngine` from
`rtsp-streamer/angular` and drive your own `<canvas>`.

> **Build note.** This binding is compiled with plain `tsc` (like the React
> one), not the Angular compiler, so it is not Ivy/AOT-precompiled. It works
> under Angular's JIT compiler; consuming it from a default AOT build needs the
> component compiled from source (e.g. a path mapping into `src/angular`). A
> proper partial-Ivy package build (`ngc --compilationMode partial` /
> `ng-packagr`) is the long-term fix but currently blocked by the repo's
> bleeding-edge TypeScript version, which the Angular compiler rejects.

## Next.js

The player as a Next.js **client component**, plus an App Router **Route
Handler** for the token endpoint. Split into two entries so the server half
never pulls the client boundary:

- `rtsp-streamer/next/client` — the `"use client"` player (the React binding,
  ready to drop into a Server Component page).
- `rtsp-streamer/next` — server helpers: `createStreamRoute()` and
  `registerRtspBridge()`.

```tsx
// app/page.tsx — a Server Component; the client boundary is inside the import
import { RtspPlayer } from "rtsp-streamer/next/client";

export default function Page() {
  return <RtspPlayer src="rtsp://user:pass@cam/stream1" autoPlay muted />;
}
```

```ts
// app/api/stream/route.ts — the token endpoint the player POSTs to
import { createStreamRoute } from "rtsp-streamer/next";

export const POST = createStreamRoute();
```

> **Next needs a custom server here.** `streamRtsp()` owns the underlying
> `http.Server` — both to mint the token _and_ to answer the `/stream/<token>`
> WebSocket upgrade — and a normal route handler can't reach that server or a
> raw socket. So run Next with a
> [custom server](https://nextjs.org/docs/app/building-your-application/configuring/custom-server)
> and register how tokens are minted; `createStreamRoute()` reads that bridge
> (shared via `globalThis`, so it survives Next's separate bundling):

```ts
// server.ts — custom server
import { createServer } from "node:http";
import next from "next";
import { streamRtsp } from "rtsp-streamer";
import { registerRtspBridge } from "rtsp-streamer/next";

const app = next({ dev: process.env.NODE_ENV !== "production" });
const handle = app.getRequestHandler();

await app.prepare();
const server = createServer((req, res) => handle(req, res));
// streamRtsp() attaches the /stream/<token> upgrade handler to this server.
registerRtspBridge((rtspUrl) => streamRtsp(server, rtspUrl));
server.listen(3000);
```

`mintStream(rtspUrl)` is also exported if you would rather mint from a Server
Action than the route handler. React (`>=18`) is the only peer dependency —
Next itself is never imported by the package.

## Framework examples

Runnable servers for the raw `http` module, Express, Fastify, and NestJS live in
[`examples/`](./examples) — see the [examples index](./examples/README.md) for
the full overview. Each hands its underlying `http.Server` to `streamRtsp()` and
serves the [shared demo page](./examples/public/README.md) from `examples/public`.

Build once (`npm run build`), then run any server and open
<http://localhost:8080>:

```bash
npm run examples:http      # plain node:http  → examples/http
npm run examples:express   # Express          → examples/express
npm run examples:fastify   # Fastify          → examples/fastify
npm run examples:nest      # NestJS           → examples/nest
npm run examples:rtp       # RTP/MPEG-TS push → examples/rtp   (ffmpeg pushes)
```

Each folder has its own walkthrough:
[`http`](./examples/http/README.md) ·
[`express`](./examples/express/README.md) ·
[`fastify`](./examples/fastify/README.md) ·
[`nest`](./examples/nest/README.md) ·
[`rtp`](./examples/rtp/README.md) ·
[`react`](./examples/react/README.md) ·
[`angular`](./examples/angular/README.md) ·
[`next`](./examples/next/README.md).

[`examples/react`](./examples/react/README.md) and
[`examples/angular`](./examples/angular/README.md) are the odd ones out: SPA apps
using `rtsp-streamer/react` / `rtsp-streamer/angular` instead of the element.
Neither ships a server — each reuses one of the servers above for the API and
WebSocket, so it runs as two processes (the backend on `:8080`, the client dev
server on `:5173` / `:4200`) and needs its own `npm install`.
[`examples/next`](./examples/next/README.md) uses `rtsp-streamer/next` on the App
Router; it's a single custom-server process (`:3000`) because that's what the
WebSocket upgrade needs.

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

## Releasing

Publishing is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml):
every push to `main` runs lint + type-check, then publishes to npm **only if
`package.json`'s version is not already on the registry**. So a release is just a
version bump:

```bash
npm version patch   # or minor / major — commits and tags
git push origin main --follow-tags
```

One-time setup: add an npm **automation** access token as the repository secret
`NPM_TOKEN` (Settings → Secrets and variables → Actions). The workflow publishes
with [provenance](https://docs.npmjs.com/generating-provenance-statements), which
needs a public repository; drop `--provenance` from the workflow if the repo is
private. Feature branches and PRs are checked by
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

ISC
