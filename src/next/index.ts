/**
 * rtsp-streamer/next — server helpers for the Next.js App Router.
 *
 * The player is a client component (see "rtsp-streamer/next/client"); this
 * entry is the *server* half — an App Router Route Handler that mints stream
 * tokens, plus the bridge that connects it to your camera connection.
 *
 * Why a bridge? streamRtsp(server, url) needs the underlying http.Server, both
 * to mint the token and to answer the /stream/<token> WebSocket upgrade. A
 * plain Next route handler has no access to that server, so Next needs a
 * *custom server* (https://nextjs.org/docs/app/building-your-application/configuring/custom-server).
 * There you already hold the http.Server, so you register how to mint:
 *
 *   // server.ts (custom server)
 *   import { streamRtsp } from "rtsp-streamer";
 *   import { registerRtspBridge } from "rtsp-streamer/next";
 *   const httpServer = http.createServer(handler);
 *   registerRtspBridge((rtspUrl) => streamRtsp(httpServer, rtspUrl));
 *
 *   // app/api/stream/route.ts
 *   import { createStreamRoute } from "rtsp-streamer/next";
 *   export const POST = createStreamRoute();
 *
 * The bridge is stored on globalThis so the custom server and the route handler
 * share it even though Next bundles them separately (same Node process).
 */

/** Mints a token-protected WebSocket path for an rtsp:// URL. */
export type MintStream = (rtspUrl: string) => string;

const BRIDGE_KEY = "__rtspStreamerNextBridge__";
type GlobalWithBridge = typeof globalThis & { [BRIDGE_KEY]?: MintStream };

const isRtspUrl = (v: unknown): v is string =>
  typeof v === "string" && /^rtsp:\/\//i.test(v);

/**
 * Register how stream tokens are minted. Call once from your custom server,
 * passing streamRtsp() bound to the http.Server it created.
 */
export function registerRtspBridge(mint: MintStream): void {
  (globalThis as GlobalWithBridge)[BRIDGE_KEY] = mint;
}

/**
 * Mint a `/stream/<token>` path for an rtsp:// URL. Usable from a Route
 * Handler or a Server Action. Throws if the bridge is not registered or the
 * URL is not rtsp://.
 */
export function mintStream(rtspUrl: string): string {
  if (!isRtspUrl(rtspUrl)) {
    throw new Error("rtspUrl (rtsp://…) is required");
  }
  const mint = (globalThis as GlobalWithBridge)[BRIDGE_KEY];
  if (!mint) {
    throw new Error(
      "rtsp-streamer/next: no bridge registered — call registerRtspBridge() " +
        "from your custom server (see the module docs)",
    );
  }
  return mint(rtspUrl);
}

/**
 * Build an App Router Route Handler for `POST /api/stream` — the endpoint the
 * <RtspPlayer> client asks for a token:
 *
 *   POST /api/stream  { "rtspUrl": "rtsp://…" }  ->  { "path": "/stream/<token>" }
 *
 *   // app/api/stream/route.ts
 *   export const POST = createStreamRoute();
 *
 * It uses only the Web `Request`/`Response` types, so it works unchanged in a
 * route handler (and does not pull Next into this package).
 */
export function createStreamRoute(): (request: Request) => Promise<Response> {
  return async function POST(request: Request): Promise<Response> {
    let rtspUrl: unknown;
    try {
      const body = (await request.json()) as { rtspUrl?: unknown };
      rtspUrl = body.rtspUrl;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!isRtspUrl(rtspUrl)) {
      return json({ error: "rtspUrl (rtsp://…) is required" }, 400);
    }
    try {
      return json({ path: mintStream(rtspUrl) });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
