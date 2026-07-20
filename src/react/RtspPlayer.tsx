/**
 * RtspPlayer.tsx — React equivalent of the <rtsp-player> custom element.
 *
 *   <RtspPlayer src="rtsp://user:pass@cam/stream1" width={960} autoPlay muted />
 *
 * A canvas plus a status overlay (hidden while playing, red on error). The
 * decoding pipeline lives in RtspEngine; this file is presentation only, so
 * anything more custom is better built on useRtspPlayer() directly.
 *
 * Imperative handle (ref): play(src?), stop(), state, playing.
 */

import {
  forwardRef,
  useImperativeHandle,
  type CSSProperties,
  type ReactNode,
} from "react";
import { type PlayerState } from "./rtsp-engine.js";
import { useRtspPlayer, type UseRtspPlayerOptions } from "./use-rtsp-player.js";

export interface RtspPlayerHandle {
  /** Start playback; defaults to the `src` prop. */
  play: (src?: string) => void;
  stop: () => void;
  readonly state: PlayerState;
  readonly playing: boolean;
}

export interface RtspPlayerProps extends UseRtspPlayerOptions {
  /** CSS width of the video surface (numbers are px). */
  width?: number | string;
  /** CSS height of the video surface (numbers are px). */
  height?: number | string;
  className?: string;
  style?: CSSProperties;
  /** Hide the built-in status overlay and render your own chrome instead. */
  hideStatus?: boolean;
  /** Rendered above the canvas — controls, badges, whatever. */
  children?: ReactNode;
}

const css = (v: number | string | undefined): string | undefined =>
  typeof v === "number" ? `${v}px` : v;

const rootStyle: CSSProperties = {
  display: "inline-block",
  position: "relative",
  background: "#000",
  borderRadius: 10,
  overflow: "hidden",
  lineHeight: 0,
};

const canvasStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  aspectRatio: "16 / 9",
  objectFit: "contain",
};

const statusStyle: CSSProperties = {
  position: "absolute",
  inset: "auto 0 0 0",
  padding: "6px 10px",
  font: "12px/1.4 system-ui, sans-serif",
  color: "#8a8a94",
  background: "linear-gradient(transparent, rgba(0, 0, 0, 0.6))",
};

export const RtspPlayer = forwardRef<RtspPlayerHandle, RtspPlayerProps>(
  function RtspPlayer(props, ref) {
    const {
      width,
      height,
      className,
      style,
      hideStatus = false,
      children,
      ...options
    } = props;

    const { canvasRef, state, status, playing, play, stop } =
      useRtspPlayer(options);

    useImperativeHandle(ref, () => ({ play, stop, state, playing }), [
      play,
      stop,
      state,
      playing,
    ]);

    return (
      <div
        className={className}
        data-state={state}
        style={{
          ...rootStyle,
          width: css(width),
          height: css(height),
          ...style,
        }}
      >
        <canvas ref={canvasRef} style={canvasStyle} />
        {!hideStatus && state !== "playing" && (
          <div
            style={
              state === "error"
                ? { ...statusStyle, color: "#ff7676" }
                : statusStyle
            }
          >
            {status}
          </div>
        )}
        {children}
      </div>
    );
  },
);
