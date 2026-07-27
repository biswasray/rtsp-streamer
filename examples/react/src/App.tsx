/**
 * App.tsx — the React equivalent of examples/public/client.js.
 *
 * Everything about streaming (token request, WebSocket, WebCodecs decode,
 * canvas) lives inside <RtspPlayer>; this component just drives it from a form
 * and mirrors its callbacks into a status line.
 *
 * The ref is used instead of `autoPlay` so that pressing Play twice with the
 * same URL restarts the stream — a `src`-only version would see no change.
 */

import { useRef, useState } from "react";
import { RtspPlayer, type RtspPlayerHandle } from "rtsp-streamer/react";
import type { PlayerState } from "rtsp-streamer/react";

const TEXT: Record<PlayerState, string> = {
  idle: "enter an RTSP URL and press Play",
  connecting: "requesting stream…",
  waiting: "waiting for keyframe…",
  playing: "live",
  error: "",
};

export function App() {
  const player = useRef<RtspPlayerHandle>(null);
  const [url, setUrl] = useState("");
  const [state, setState] = useState<PlayerState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);

  const busy = state === "connecting" || state === "waiting";

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          player.current?.play(url.trim());
        }}
      >
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="rtsp://user:pass@192.168.1.10:554/stream1"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <button type="submit" disabled={busy}>
          Play
        </button>
        <button
          type="button"
          className="stop"
          disabled={state === "idle" || state === "error"}
          onClick={() => player.current?.stop()}
        >
          Stop
        </button>
      </form>

      <label className="mute">
        <input
          type="checkbox"
          checked={muted}
          onChange={(e) => setMuted(e.target.checked)}
        />
        muted (applies live — no restart)
      </label>

      <div className={error ? "status err" : "status"}>
        {error ?? TEXT[state]}
      </div>

      {/* hideStatus: the page already has its own status line above. */}
      <RtspPlayer
        ref={player}
        src={url}
        muted={muted}
        hideStatus
        className="player"
        onStateChange={(s) => {
          setState(s);
          if (s !== "error") setError(null);
        }}
        onError={setError}
      />
    </>
  );
}
