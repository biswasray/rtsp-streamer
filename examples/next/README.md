# Next.js example

The same demo, built with `rtsp-streamer/next` on the Next.js **App Router**. It
shows the three pieces of the Next integration:

- **`app/page.tsx`** — a Server Component page that renders the client
  `<PlayerPanel>`.
- **`app/player-panel.tsx`** — `"use client"`; the form + `<RtspPlayer>` (from
  `rtsp-streamer/next/client`).
- **`app/api/stream/route.ts`** — `export const POST = createStreamRoute()`.
- **`server.ts`** — the **custom server** (see below).

## Why the custom server

`streamRtsp()` owns the underlying `http.Server` — both to mint the token and to
answer the `/stream/<token>` WebSocket upgrade — and a normal route handler
can't reach that server or a raw socket. So this example runs Next with a
[custom server](https://nextjs.org/docs/app/building-your-application/configuring/custom-server)
that creates the `http.Server`, gives it Next's request handler, and registers
how tokens are minted:

```ts
registerRtspBridge((rtspUrl) => streamRtsp(server, rtspUrl));
```

`createStreamRoute()` in the route handler then reads that bridge (shared via
`globalThis`) to mint. Unlike the other framework examples, this one **is** the
server, so there is nothing else to run alongside it.

## Run

From the repo root, build the package once so `dist/` exists (this example links
it with `file:../..`), then install and start:

```bash
npm run build                      # builds dist/ (once)
npm --prefix examples/next install # installs this example's deps (once)
npm run examples:next              # custom server on :3000 (from repo root)
```

Open <http://localhost:3000>, paste an RTSP URL, and press **Play**. No camera
handy? See "Local testing" in the root README for a MediaMTX + ffmpeg webcam
stream.

## The example-only bits

- **`rtsp-streamer` is linked with `file:../..`** so the example uses your local
  build. In your own app you would `npm i rtsp-streamer`.
- **`next.config.mjs` pins React to this app's copy.** Because the package is
  symlinked from the repo, its compiled `import "react"` could otherwise resolve
  to a second React under the repo root and break hooks. Not needed once the
  package is installed normally.
