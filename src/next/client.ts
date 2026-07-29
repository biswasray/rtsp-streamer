"use client";

/**
 * rtsp-streamer/next/client — the player as a Next.js client component.
 *
 *   import { RtspPlayer } from "rtsp-streamer/next/client";
 *
 * This is the React binding re-exported behind a "use client" boundary, so it
 * drops straight into an App Router Server Component page without the consumer
 * having to add the directive themselves:
 *
 *   // app/page.tsx  (a Server Component)
 *   import { RtspPlayer } from "rtsp-streamer/next/client";
 *   export default function Page() {
 *     return <RtspPlayer src="rtsp://user:pass@cam/stream1" autoPlay muted />;
 *   }
 *
 * The player POSTs to /api/stream (see createStreamRoute in
 * "rtsp-streamer/next") and opens the returned WebSocket. Everything the React
 * binding exports is re-exported here.
 */

export { RtspPlayer } from "../react/RtspPlayer.js";
export type { RtspPlayerHandle, RtspPlayerProps } from "../react/RtspPlayer.js";
export { useRtspPlayer } from "../react/use-rtsp-player.js";
export type {
  UseRtspPlayerOptions,
  UseRtspPlayerResult,
} from "../react/use-rtsp-player.js";
export { RtspEngine } from "../react/rtsp-engine.js";
export type { PlayerState, RtspEngineOptions } from "../react/rtsp-engine.js";
