/**
 * client.js — browser side (no libraries).
 *
 * 1. POST /api/stream { rtspUrl }  ->  { path: "/stream/<token>" }
 * 2. Open a WebSocket on that path.
 * 3. Each binary message: [1 byte key flag][Annex-B H.264 access unit]
 * 4. Decode with WebCodecs VideoDecoder, paint frames on <canvas>.
 */

const form = document.getElementById("form");
const input = document.getElementById("rtspUrl");
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("video");
const ctx = canvas.getContext("2d");

let ws = null;
let decoder = null;
let gotKey = false;
let frameNo = 0;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
}

function stop() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  if (decoder && decoder.state !== "closed") decoder.close();
  decoder = null;
  gotKey = false;
  frameNo = 0;
  playBtn.disabled = false;
  stopBtn.disabled = true;
}

function initDecoder(codec) {
  decoder = new VideoDecoder({
    output: (frame) => {
      if (canvas.width !== frame.displayWidth) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();
    },
    error: (e) => setStatus("decode error: " + e.message, true),
  });
  // No "description" in the config => decoder accepts Annex-B directly.
  decoder.configure({ codec, optimizeForLatency: true });
}

function onMessage(ev) {
  const u8 = new Uint8Array(ev.data);
  const isKey = u8[0] === 1;
  const data = u8.subarray(1);

  if (!decoder) {
    if (!isKey) return;
    // Key unit starts [00 00 00 01][SPS] — profile/compat/level bytes
    // follow the 1-byte NAL header, so offsets 5..7.
    const hex = (b) => b.toString(16).padStart(2, "0");
    initDecoder("avc1." + hex(data[5]) + hex(data[6]) + hex(data[7]));
  }
  if (!gotKey && !isKey) return; // must start on a keyframe
  gotKey = true;

  decoder.decode(
    new EncodedVideoChunk({
      type: isKey ? "key" : "delta",
      timestamp: frameNo++ * 33333, // monotonic µs (~30 fps)
      data,
    }),
  );
  setStatus("live");
}

async function play(rtspUrl) {
  stop();
  playBtn.disabled = true;

  if (!("VideoDecoder" in window)) {
    setStatus("WebCodecs is not supported in this browser", true);
    playBtn.disabled = false;
    return;
  }

  setStatus("requesting stream…");
  let path;
  try {
    const res = await fetch("/api/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rtspUrl }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "server error " + res.status);
    path = body.path; // e.g. "/stream/6bd1…e2"
  } catch (e) {
    setStatus(e.message, true);
    playBtn.disabled = false;
    return;
  }

  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(proto + location.host + path);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    setStatus("waiting for keyframe…");
    stopBtn.disabled = false;
  };
  ws.onmessage = onMessage;
  ws.onerror = () => setStatus("websocket error", true);
  ws.onclose = () => {
    setStatus("disconnected");
    stop();
  };
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  play(input.value.trim());
});
stopBtn.addEventListener("click", () => {
  stop();
  setStatus("stopped");
});
