/**
 * use-rtsp-player.ts — React binding for RtspEngine.
 *
 *   const { canvasRef, state, status, play, stop } = useRtspPlayer({
 *     src: "rtsp://user:pass@cam/stream1",
 *     autoPlay: true,
 *     muted: true,
 *   });
 *   return <canvas ref={canvasRef} />;
 *
 * One engine per mount: it is created when the canvas attaches and disposed on
 * unmount. Callback props are read through a ref, so passing inline arrow
 * functions never tears the stream down. Changing `src` (with autoPlay, or
 * while already playing) restarts playback; changing `muted` applies live.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RtspEngine, type PlayerState } from "./rtsp-engine.js";

export interface UseRtspPlayerOptions {
  /** RTSP URL to play (rtsp://…). */
  src?: string;
  /** Play as soon as the canvas mounts, and whenever `src` changes. */
  autoPlay?: boolean;
  /** Mute audio output; toggleable live, like <video>. */
  muted?: boolean;
  /** Endpoint that mints a stream token. Default "/api/stream". */
  api?: string;
  onPlaying?: () => void;
  onStopped?: () => void;
  onError?: (message: string) => void;
  onStateChange?: (state: PlayerState) => void;
}

export interface UseRtspPlayerResult {
  /** Attach to the <canvas> the stream draws into. */
  canvasRef: (node: HTMLCanvasElement | null) => void;
  state: PlayerState;
  /** Human-readable status line ("waiting for keyframe…", the error, …). */
  status: string;
  /** Last error message, cleared on the next successful play(). */
  error: string | null;
  playing: boolean;
  /** Start playback; defaults to the `src` option. */
  play: (src?: string) => void;
  stop: () => void;
}

export function useRtspPlayer(
  options: UseRtspPlayerOptions = {},
): UseRtspPlayerResult {
  const { src, autoPlay = false, muted = false } = options;

  const [state, setState] = useState<PlayerState>("idle");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState<string | null>(null);

  const engineRef = useRef<RtspEngine | null>(null);
  // Latest props/callbacks without re-creating the engine on every render.
  const latest = useRef(options);
  latest.current = options;

  const canvasRef = useCallback((node: HTMLCanvasElement | null): void => {
    engineRef.current?.dispose();
    engineRef.current = null;
    if (!node) return;

    engineRef.current = new RtspEngine(node, {
      // Getter: a changed `api` prop applies to the next play() call.
      get api() {
        return latest.current.api;
      },
      muted: latest.current.muted ?? false,
      onState: (s, text) => {
        setState(s);
        setStatus(text);
        if (s !== "error") setError(null);
        latest.current.onStateChange?.(s);
      },
      onPlaying: () => latest.current.onPlaying?.(),
      onStopped: () => latest.current.onStopped?.(),
      onError: (message) => {
        setError(message);
        latest.current.onError?.(message);
      },
    });

    if (latest.current.autoPlay && latest.current.src)
      void engineRef.current.play(latest.current.src);
  }, []);

  useEffect(
    () => () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    },
    [],
  );

  const play = useCallback((next?: string): void => {
    const engine = engineRef.current;
    const url = next ?? latest.current.src;
    if (!engine || !url) return;
    void engine.play(url);
  }, []);

  const stop = useCallback((): void => engineRef.current?.stop(), []);

  // A new source replaces whatever is on screen; an emptied one just stops.
  const firstSrc = useRef(true);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (firstSrc.current) {
      // The ref callback already handled the initial autoPlay.
      firstSrc.current = false;
      return;
    }
    if (!src) engine.stop();
    else if (autoPlay || engine.playing) void engine.play(src);
  }, [src, autoPlay]);

  useEffect(() => {
    engineRef.current?.setMuted(muted);
  }, [muted]);

  return {
    canvasRef,
    state,
    status,
    error,
    playing: state === "playing",
    play,
    stop,
  };
}
