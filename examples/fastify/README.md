# `fastify` example

The [`http` example](../http) re-expressed with [Fastify](https://fastify.dev).

## What it does

- `app.post("/api/stream")` → `{ path: "/stream/<token>" }`, minted with
  `streamRtsp()`. `bodyLimit: 4096` caps the tiny request body.
- Serves `/rtsp-player.js` via `serveRtspPlayer()` from an `onRequest` hook.
- Serves the demo page from [`../public`](../public) with `@fastify/static`.
- Handles the `/stream/<token>` WebSocket upgrade (wired up by `streamRtsp()`).

## Run

From the repo root (build once so `dist/` exists):

```bash
npm run build
npm run examples:fastify
```

Open <http://localhost:8080>, paste an RTSP URL, and press **Play**.

## Key detail

Fastify creates and owns the underlying `http.Server`, exposed as `app.server` —
that is what we hand to `streamRtsp()` for the `upgrade` handler. Fastify keeps
ownership of the ordinary HTTP routes.

Serving `/rtsp-player.js` writes straight to the raw response, so the hook calls
`reply.hijack()` to tell Fastify to leave that reply alone:

```ts
app.addHook("onRequest", (req, reply, done) => {
  if (serveRtspPlayer(req.raw, reply.raw)) reply.hijack();
  else done();
});
```

Source: [`server.ts`](./server.ts).
