# React example

The same demo as the other examples, built with `rtsp-streamer/react` instead of
the `<rtsp-player>` element. Two processes: an existing example server for the
API and the WebSocket, and Vite for the client.

This example has **no server of its own**. Any of the other example servers
(`http`, `express`, `fastify`, `nest`) already answer `POST /api/stream` and
handle the `/stream/<token>` WebSocket upgrade, which is everything the React
client needs — so it just reuses one. The commands below use `express`; swap in
`examples:http`, `examples:fastify`, or `examples:nest` and it works the same.

## Run

From the repo root, build the package once so `dist/` exists:

```bash
npm run build
```

Then, in two terminals:

```bash
npm run examples:express                       # API + WebSocket on :8080
cd examples/react && npm install && npm run dev   # Vite on :5173
```

Open <http://localhost:5173>, paste an RTSP URL, and press **Play**. No camera
handy? See "Local testing" in the root README for a MediaMTX + ffmpeg webcam
stream.

## How it fits together

- **The backend** (e.g. `examples/express/server.ts`) answers
  `POST /api/stream` with `{ path: "/stream/<token>" }` and handles the
  WebSocket upgrade. It also serves the plain-HTML client at `/`, but the React
  example ignores that — Vite owns the client here.
- **`vite.config.ts`** proxies `/api` and `/stream` to `:8080`. The `/stream`
  entry needs `ws: true`; the player derives its socket URL from
  `location.host`, so without the proxy it would open against Vite and 404.
- **`src/App.tsx`** is the whole client: a form, a status line, and
  `<RtspPlayer>`.

One thing here is example-only: `vite.config.ts` aliases `rtsp-streamer/react`
to `../../dist/react` because the package is not installed inside the repo. In
your own app, `npm i rtsp-streamer` and the bare import resolves on its own —
delete the alias.
