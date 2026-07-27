# `nest` example

The [`http` example](../http) re-expressed with [NestJS](https://nestjs.com) on
the Express platform.

## What it does

- A `StreamController` with `@Post("stream")` under the `api` prefix →
  `{ path: "/stream/<token>" }`, minted with `streamRtsp()`; invalid input
  raises `BadRequestException`.
- Serves `/rtsp-player.js` via `serveRtspPlayer()` from `app.use(...)`.
- Serves the demo page from [`../public`](../public) with `useStaticAssets()`.
- Handles the `/stream/<token>` WebSocket upgrade (wired up by `streamRtsp()`).

## Run

From the repo root (build once so `dist/` exists):

```bash
npm run build
npm run examples:nest
```

Open <http://localhost:8080>, paste an RTSP URL, and press **Play**.

## Key details

- Nest (Express platform) creates and owns the `http.Server`; we grab it during
  bootstrap with `app.getHttpServer()` and hand it to `streamRtsp()` for the
  `upgrade` handler.
- This example is run with **tsx/esbuild**, which does not emit decorator
  _metadata_ (`design:paramtypes`). So it avoids constructor-based dependency
  injection and shares the `http.Server` through a module-scoped variable set in
  `bootstrap()`. A normal `nest build` (with `emitDecoratorMetadata`) would let
  you inject it instead.
- Uses [`tsconfig.json`](./tsconfig.json) in this folder — hence the dedicated
  `--tsconfig` flag in the `examples:nest` script.

Source: [`server.ts`](./server.ts).
