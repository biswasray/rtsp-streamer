# Angular example

The same demo as the other examples, built with `rtsp-streamer/angular` (the
standalone `RtspPlayerComponent`) instead of the `<rtsp-player>` element. Two
processes: an existing example server for the API and the WebSocket, and the
Angular CLI dev server for the client.

Like the React example, this app has **no server of its own** — it reuses any of
the `http` / `express` / `fastify` / `nest` servers, which already answer
`POST /api/stream` and handle the `/stream/<token>` WebSocket upgrade. The
commands below use `express`.

## Run

From the repo root, build the package once so `dist/` exists, then install this
example's own dependencies (Angular + CLI):

```bash
npm run build                         # builds dist/ (once)
npm --prefix examples/angular install # installs this example's deps (once)
```

Then, in two terminals:

```bash
npm run examples:express   # backend: API + WebSocket on :8080  (from repo root)
npm run examples:angular   # client: ng serve on :4200          (from repo root)
```

Swap `examples:express` for `examples:http`, `examples:fastify` or
`examples:nest` — any of them works. (`npm run examples:angular` is just
`cd examples/angular && npm start`.)

Open <http://localhost:4200>, paste an RTSP URL, and press **Play**. No camera
handy? See "Local testing" in the root README for a MediaMTX + ffmpeg webcam
stream.

## How it fits together

- **The backend** (e.g. `examples/express/server.ts`) answers `POST /api/stream`
  with `{ path: "/stream/<token>" }` and handles the WebSocket upgrade. It also
  serves the plain-HTML client at `/`, which this example ignores — the Angular
  CLI owns the client.
- **`proxy.conf.json`** proxies `/api` and `/stream` to `:8080`. The `/stream`
  entry needs `"ws": true`; the player derives its socket URL from
  `location.host`, so without the proxy it would open against `:4200` and 404.
- **`src/app/app.component.ts`** is the whole client: a form, a status line, and
  `<rtsp-player>`.

## The one example-only detail

`tsconfig.json` maps `rtsp-streamer/angular` to the binding's **source**
(`../../src/angular`) instead of the published `dist/`. This example does that on
purpose: the binding is compiled with plain `tsc`, so it is not Ivy/AOT-
precompiled, and pointing at source lets the Angular compiler here turn the
component (and the shared `RtspEngine`) into Ivy — which is what makes it run in
this AOT build.

In your own app you would `npm i rtsp-streamer` and import
`"rtsp-streamer/angular"` directly. Note that a plain `tsc`-built binding needs
Angular's JIT compiler or source compilation; a partial-Ivy package build
(`ng-packagr`) is the drop-in-for-AOT path — see the root README's Angular
build note.
