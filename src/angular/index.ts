/**
 * rtsp-streamer/angular — Angular player for streams served by streamRtsp().
 *
 *   import { RtspPlayerComponent } from "rtsp-streamer/angular";
 *
 * `RtspPlayerComponent` is the standalone drop-in component; `RtspEngine` is the
 * framework-free core (socket + WebCodecs decoders + Web Audio; you supply the
 * <canvas>) if you want to build custom chrome instead.
 */

export { RtspPlayerComponent } from "./rtsp-player.component.js";
export { RtspEngine } from "../react/rtsp-engine.js";
export type { PlayerState, RtspEngineOptions } from "../react/rtsp-engine.js";
