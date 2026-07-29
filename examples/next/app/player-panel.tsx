"use client";

/**
 * player-panel.tsx — the interactive client half of the demo (the Next.js
 * equivalent of examples/react/src/App.tsx).
 *
 * Everything about streaming lives inside <RtspPlayer>; this drives it from a
 * form and mirrors its callbacks into a status line. A ref is used (rather than
 * `src` + autoPlay) so pressing Play twice with the same URL restarts.
 */

import { useRef, useState } from "react";
import {
  RtspPlayer,
  type RtspPlayerHandle,
  type PlayerState,
} from "rtsp-streamer/next/client";

const TEXT: Record<PlayerState, string> = {
  idle: "enter an RTSP URL and press Play",
  connecting: "requesting stream…",
  waiting: "waiting for keyframe…",
  playing: "live",
  error: "",
};

export function PlayerPanel() {
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
