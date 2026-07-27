# Shared browser client

The demo page served by the [`http`](../http), [`express`](../express),
[`fastify`](../fastify) and [`nest`](../nest) examples. (The [`react`](../react)
example does **not** use this — it renders its own client with Vite.)

- **`index.html`** — a form, a status line, and the `<rtsp-player>` element. It
  loads `/rtsp-player.js` (served by the package, not from this folder) and
  `client.js`.
- **`client.js`** — page glue: drives `player.play()` / `player.stop()` from the
  form and mirrors the element's `statechange` / `error` events into the status
  line.

All of the streaming — token request, WebSocket, WebCodecs decode, canvas —
lives inside `<rtsp-player>`. These two files are only the surrounding page, so
they double as the smallest possible integration reference: load the script,
drop the element, call `play()`.

To skip the form entirely, put `src="rtsp://…" autoplay` on the element in
`index.html`.
