/**
 * app/api/stream/route.ts — the token endpoint the <RtspPlayer> POSTs to.
 *
 *   POST /api/stream  { "rtspUrl": "rtsp://…" }  ->  { "path": "/stream/<token>" }
 *
 * createStreamRoute() reads the bridge registered by the custom server
 * (see ../../../server.ts) and mints via streamRtsp(). Nothing else to write.
 */

import { createStreamRoute } from "rtsp-streamer/next";

export const POST = createStreamRoute();
