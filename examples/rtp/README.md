# RTP / MPEG-TS example

The other examples **pull** from an RTSP camera. This one is the opposite:
ffmpeg **pushes** an MPEG-TS stream to the server over RTP (or bare UDP), and
`streamRtp()` demuxes the H.264 + AAC out of it and forwards it to the same
`<rtsp-player>` over the usual WebSocket wire format.

```
ffmpeg ──RTP/MPEG-TS(UDP)──▶ streamRtp() ──WebSocket──▶ <rtsp-player>
```

## What it does

- `POST /api/stream` routes by scheme: `rtp://` / `udp://` → `streamRtp()`,
  `rtsp://` → `streamRtsp()` (so this server also handles cameras).
- Serves `/rtsp-player.js` and the shared demo page from [`../public`](../public).

## Run

From the repo root, build once so `dist/` exists, then start the server:

```bash
npm run build
npm run examples:rtp        # http://localhost:8080
```

Then push a stream from ffmpeg. Your webcam, as MPEG-TS over RTP:

```bash
ffmpeg -f dshow -i video="Integrated Camera":audio="Microphone Array (Realtek(R) Audio)" \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -b:v 2000k \
  -g 30 -c:a aac -b:a 128k -f rtp_mpegts rtp://127.0.0.1:5004
```

Open <http://localhost:8080>, enter **`rtp://127.0.0.1:5004`**, and press
**Play**.

No camera? A test pattern works the same:

```bash
ffmpeg -re -f lavfi -i testsrc=size=640x480:rate=30 -f lavfi -i sine=frequency=440 \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 30 \
  -c:a aac -b:a 128k -f rtp_mpegts rtp://127.0.0.1:5004
```

## Notes

- **`-g 30`** sets ffmpeg's keyframe interval to ~1s. Without it (as in the
  original one-liner) ffmpeg uses a large default GOP, so the player can wait up
  to ~8s for the first keyframe before video appears. The stream still works
  either way.
- **`-f rtp_mpegts rtp://…`** wraps the TS in RTP (payload type 33). Plain
  **`-f mpegts udp://…`** (no RTP) is auto-detected and works too.
- The server binds the UDP port when the first viewer presses Play. ffmpeg can
  be started before or after; it re-syncs on the next PAT/PMT + keyframe.
- Only **H.264 video + AAC audio** are demuxed (what the browser can decode).
