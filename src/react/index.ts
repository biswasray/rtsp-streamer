/**
 * rtsp-streamer/react — React player for streams served by streamRtsp().
 *
 *   import { RtspPlayer } from "rtsp-streamer/react";
 *
 * `RtspPlayer` is the drop-in component; `useRtspPlayer` is the same engine
 * without any markup, for custom chrome; `RtspEngine` is the framework-free
 * core if you want neither.
 */

export { RtspPlayer } from "./RtspPlayer.js";
export type { RtspPlayerHandle, RtspPlayerProps } from "./RtspPlayer.js";
export { useRtspPlayer } from "./use-rtsp-player.js";
export type {
  UseRtspPlayerOptions,
  UseRtspPlayerResult,
} from "./use-rtsp-player.js";
export { RtspEngine } from "./rtsp-engine.js";
export type { PlayerState, RtspEngineOptions } from "./rtsp-engine.js";
