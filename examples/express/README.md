# `express` example

The [`http` example](../http) re-expressed with [Express](https://expressjs.com).
Express owns the ordinary routes; `rtsp-streamer` owns the WebSocket.

## What it does

- `app.post("/api/stream")` → `{ path: "/stream/<token>" }`, minted with
  `streamRtsp()`. `express.json({ limit: "4kb" })` parses the tiny body.
- Serves `/rtsp-player.js` via `serveRtspPlayer()` from a small middleware.
- Serves the demo page from [`../public`](../public) with `express.static()`.
- Handles the `/stream/<token>` WebSocket upgrade (wired up by `streamRtsp()`).

## Run

From the repo root (build once so `dist/` exists):

```bash
npm run build
npm run examples:express
```

Open <http://localhost:8080>, paste an RTSP URL, and press **Play**.

## Key detail

The WebSocket `upgrade` is handled on the raw `http.Server`, not by Express. So
we build the server explicitly with `http.createServer(app)` and hand **that**
to `streamRtsp()`; Express (`app`) is just its request listener and keeps
ownership of the HTTP routes.

```ts
const app = express();
const server = http.createServer(app);
// ...routes...
streamRtsp(server, rtspUrl); // upgrade handler goes on `server`
```

Source: [`server.ts`](./server.ts).
