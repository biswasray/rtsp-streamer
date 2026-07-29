# Examples

Runnable demos of `rtsp-streamer`. Every example implements the same two-part
contract the `<rtsp-player>` client expects:

```
POST /api/stream  { "rtspUrl": "rtsp://…" }  ->  { "path": "/stream/<token>" }
GET  /stream/<token>   (WebSocket upgrade)   ->  H.264 access units + audio
```

The four server examples differ only in the HTTP framework. They share the
browser client in [`public/`](./public) and all listen on **`:8080`**. The
`react`, `angular` and `next` examples are the exceptions — each renders its own
client and either reuses one of the servers (`react`, `angular`) or is its own
server (`next`).

| Example                | Framework                             | Command                               |
| ---------------------- | ------------------------------------- | ------------------------------------- |
| [`http`](./http)       | Node `http` (no framework)            | `npm run examples:http`               |
| [`express`](./express) | Express                               | `npm run examples:express`            |
| [`fastify`](./fastify) | Fastify                               | `npm run examples:fastify`            |
| [`nest`](./nest)       | NestJS (Express platform)             | `npm run examples:nest`               |
| [`react`](./react)     | Vite + `rtsp-streamer/react`          | see its [README](./react/README.md)   |
| [`angular`](./angular) | Angular CLI + `rtsp-streamer/angular` | see its [README](./angular/README.md) |
| [`next`](./next)       | Next.js App Router + `rtsp-streamer/next` | see its [README](./next/README.md) |

## Prerequisite

Build the package once from the repo root so `dist/` exists (the examples import
from `../../dist`):

```bash
npm run build
```

Then run any server and open <http://localhost:8080>. Paste an RTSP URL and
press **Play**. No camera handy? See "Local testing" in the
[root README](../README.md#local-testing).

## The key detail across frameworks

The WebSocket `upgrade` is handled on the raw `http.Server`, so each example
obtains that server explicitly and hands **it** to `streamRtsp()`:

| Example   | How the `http.Server` is obtained |
| --------- | --------------------------------- |
| `http`    | `http.createServer(handler)`      |
| `express` | `http.createServer(app)`          |
| `fastify` | `app.server`                      |
| `nest`    | `app.getHttpServer()`             |

The framework keeps ownership of the ordinary HTTP routes; `streamRtsp()` only
adds the upgrade handler and serves `/rtsp-player.js` ahead of them.

## Shared browser client — [`public/`](./public)

`index.html` + `client.js`, served by the four server examples. All the
streaming lives inside `<rtsp-player>`; these files are just the surrounding
page. See [`public/README.md`](./public/README.md).
