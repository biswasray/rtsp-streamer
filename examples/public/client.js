/**
 * client.js — page glue for the demo.
 *
 * All of the streaming (token request, WebSocket, WebCodecs decode, canvas)
 * lives inside <rtsp-player>; this file just drives it from the form and
 * mirrors its events into the page's status line.
 */

const form = document.getElementById("form");
const input = document.getElementById("rtspUrl");
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const player = document.getElementById("player");

const TEXT = {
  idle: "enter an RTSP URL and press Play",
  connecting: "requesting stream…",
  waiting: "waiting for keyframe…",
  playing: "live",
};

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void player.play(input.value.trim());
});

stopBtn.addEventListener("click", () => player.stop());

player.addEventListener("statechange", (e) => {
  const { state } = e.detail;
  if (state !== "error") setStatus(TEXT[state] ?? state);
  playBtn.disabled = state === "connecting" || state === "waiting";
  stopBtn.disabled = state === "idle" || state === "error";
});

player.addEventListener("error", (e) => setStatus(e.detail.message, true));
