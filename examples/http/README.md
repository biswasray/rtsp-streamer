# `http` example

The reference server, using only Node's built-in `http` module — no framework.
**Start here:** the Express, Fastify and NestJS examples are this same demo
re-expressed in each framework.

## What it does

- `POST /api/stream` `{ rtspUrl }` → `{ path: "/stream/<token>" }`, minted with
  [`streamRtsp()`](../../README.md#streamrtspserver-rtspurl-string).
- Serves the bundled `<rtsp-player>` element at `/rtsp-player.js` with
  [`serveRtspPlayer()`](../../README.md#servertspplayerreq-res-mountpath-boolean)
  — no copy step, no bundler.
- Serves the demo page from [`../public`](../public) (with a small path-traversal
  guard).
- Handles the `/stream/<token>` WebSocket upgrade (wired up by `streamRtsp()`).

## Run

From the repo root (build once so `dist/` exists):

```bash
npm run build
npm run examples:http
```

Open <http://localhost:8080>, paste an RTSP URL, and press **Play**.

## Key detail

`streamRtsp()` needs the underlying `http.Server` to attach its `upgrade`
handler, so we pass the `server` returned by `http.createServer()`. Because the
first `streamRtsp()` call wraps the server's request listener to serve
`/rtsp-player.js` ahead of your routes, call `serveRtspPlayer()` yourself in the
handler too, so the script is available on the very first page load.

Source: [`server.ts`](./server.ts).
