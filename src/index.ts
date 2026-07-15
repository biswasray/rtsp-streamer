/**
 * rtsp-stream.ts — Reusable, zero-dependency RTSP -> WebSocket streaming module.
 *
 *   import { streamRTSP } from './rtsp-stream.ts';
 *   const path = streamRTSP(server, 'rtsp://user:pass@cam/stream1');
 *   // -> "/stream/3f9c2e...b1" (WebSocket endpoint, token-protected)
 *
 * Behaviour:
 *  - Attaches ONE 'upgrade' handler to the given http.Server (idempotent).
 *  - Serves the bundled <rtsp-player> browser element at /rtsp-player.js from
 *    this package's dist/html, so pages can just
 *    `<script type="module" src="/rtsp-player.js">` — no copy step. See
 *    serveRtspPlayer() to mount it yourself at a different path.
 *  - One RTSP session per unique rtspUrl (many viewers share one camera
 *    connection); every streamRTSP() call returns a fresh access token.
 *  - New viewers immediately receive the last cached keyframe (SPS+PPS+IDR),
 *    so video starts without waiting for the camera's next IDR.
 *  - When a session has had no viewers for IDLE_MS it sends TEARDOWN and
 *    frees itself (its tokens become invalid).
 *
 * Wire format per WebSocket binary message:
 *   [1 byte: 1=key, 0=delta][Annex-B H.264 access unit]
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as http from "node:http";
import type { Duplex } from "node:stream";

const START = Buffer.from([0, 0, 0, 1]);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const IDLE_MS = 60_000;

interface DigestParams {
  realm: string;
  nonce: string;
  qop: string | null;
  opaque: string | null;
}

type AuthMode = "basic" | "digest" | null;
type RtspMethod =
  "OPTIONS" | "DESCRIBE" | "SETUP" | "PLAY" | "GET_PARAMETER" | "TEARDOWN";

/* ------------------------- WebSocket helpers --------------------------- */

function wsFrame(payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x82, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function tagged(isKey: boolean, annexb: Buffer): Buffer {
  return Buffer.concat([Buffer.from([isKey ? 1 : 0]), annexb]);
}

/* ---------------------------- RTSP session ----------------------------- */

class RtspSession {
  readonly clients = new Set<Duplex>();

  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  private readonly pass: string;
  private readonly cleanUrl: string;

  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private fuBuf: Buffer | null = null;
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private lastKeyUnit: Buffer | null = null;

  private cseq = 0;
  private session: string | null = null;
  private authMode: AuthMode = null;
  private digestParams: DigestParams | null = null;
  private nonceCount = 0;
  private authRetries = 0;
  private contentBase: string;
  private lastMethod: RtspMethod | null = null;
  private lastUrl: string | null = null;

  private keepAlive: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  readonly rtspUrl: string;
  private readonly onDispose: () => void;

  constructor(rtspUrl: string, onDispose: () => void) {
    this.rtspUrl = rtspUrl;
    this.onDispose = onDispose;
    const u = new URL(rtspUrl);
    this.host = u.hostname;
    this.port = Number(u.port) || 554;
    this.user = decodeURIComponent(u.username || "");
    this.pass = decodeURIComponent(u.password || "");
    u.username = "";
    u.password = "";
    this.cleanUrl = u.toString().replace(/\/$/, "");
    this.contentBase = this.cleanUrl;

    this.connect();
    this.armIdleTimer(); // dispose if nobody ever connects
  }

  /* ------------------------- viewer management ------------------------- */

  addClient(socket: Duplex): void {
    this.clients.add(socket);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Instant start: replay the last keyframe access unit to the newcomer.
    if (this.lastKeyUnit) socket.write(wsFrame(tagged(true, this.lastKeyUnit)));

    socket.on("data", (d: Buffer) => {
      // minimal client-frame handling
      const opcode = (d[0] ?? 0) & 0x0f;
      if (opcode === 8) socket.end(); // close
      if (opcode === 9) socket.write(Buffer.from([0x8a, 0x00])); // ping->pong
    });
    const drop = (): void => {
      if (!this.clients.delete(socket)) return;
      console.log(`[ws] viewer left (${this.clients.size}) ${this.host}`);
      if (this.clients.size === 0) this.armIdleTimer();
    };
    socket.on("close", drop);
    socket.on("error", drop);
    console.log(`[ws] viewer joined (${this.clients.size}) ${this.host}`);
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0) this.dispose();
    }, IDLE_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    console.log(`[rtsp] disposing session ${this.host}`);
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sock && !this.sock.destroyed) {
      if (this.session) this.send("TEARDOWN", this.contentBase);
      this.sock.end();
    }
    for (const c of this.clients) {
      c.write(Buffer.from([0x88, 0x00])); // WS close
      c.end();
    }
    this.clients.clear();
    this.onDispose();
  }

  /* --------------------------- RTSP protocol --------------------------- */

  private connect(): void {
    if (this.disposed) return;
    this.buf = Buffer.alloc(0);
    this.fuBuf = null;
    this.session = null;
    this.authRetries = 0;

    this.sock = net.createConnection(this.port, this.host, () => {
      console.log(`[rtsp] connected ${this.host}:${this.port}`);
      this.send("OPTIONS", this.cleanUrl);
    });
    this.sock.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      this.pump();
    });
    this.sock.on("error", (e: Error) =>
      console.error("[rtsp] error:", e.message),
    );
    this.sock.on("close", () => {
      if (this.keepAlive) {
        clearInterval(this.keepAlive);
        this.keepAlive = null;
      }
      if (this.disposed) return;
      console.log("[rtsp] closed — reconnecting in 3s");
      setTimeout(() => this.connect(), 3000);
    });
  }

  private send(
    method: RtspMethod,
    url: string,
    extra: Record<string, string> = {},
  ): void {
    if (!this.sock) return;
    this.cseq++;
    let m = `${method} ${url} RTSP/1.0\r\nCSeq: ${this.cseq}\r\nUser-Agent: node-raw-rtsp\r\n`;
    if (this.session) m += `Session: ${this.session}\r\n`;
    if (this.authMode) m += `Authorization: ${this.makeAuth(method, url)}\r\n`;
    for (const [k, v] of Object.entries(extra)) m += `${k}: ${v}\r\n`;
    this.sock.write(m + "\r\n");
    this.lastMethod = method;
    this.lastUrl = url;
  }

  private parseChallenge(head: string): void {
    const www = head.match(/WWW-Authenticate:\s*(.+)/i)?.[1] ?? "";
    if (/^Digest/i.test(www)) {
      this.digestParams = {
        realm: www.match(/realm="([^"]*)"/)?.[1] ?? "",
        nonce: www.match(/nonce="([^"]*)"/)?.[1] ?? "",
        qop: www.match(/qop="?([^",\s]+)"?/)?.[1] ?? null,
        opaque: www.match(/opaque="([^"]*)"/)?.[1] ?? null,
      };
      this.authMode = "digest";
      this.nonceCount = 0;
    } else if (/^Basic/i.test(www)) {
      this.authMode = "basic";
    }
  }

  private makeAuth(method: string, url: string): string {
    if (this.authMode === "basic")
      return (
        "Basic " + Buffer.from(`${this.user}:${this.pass}`).toString("base64")
      );
    const dp = this.digestParams!;
    const md5 = (s: string): string =>
      crypto.createHash("md5").update(s).digest("hex");
    const ha1 = md5(`${this.user}:${dp.realm}:${this.pass}`);
    const ha2 = md5(`${method}:${url}`);
    let response: string;
    let extra = "";
    if (dp.qop) {
      const nc = String(++this.nonceCount).padStart(8, "0");
      const cnonce = crypto.randomBytes(8).toString("hex");
      response = md5(`${ha1}:${dp.nonce}:${nc}:${cnonce}:auth:${ha2}`);
      extra = `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
    } else {
      response = md5(`${ha1}:${dp.nonce}:${ha2}`);
    }
    if (dp.opaque) extra += `, opaque="${dp.opaque}"`;
    return `Digest username="${this.user}", realm="${dp.realm}", nonce="${dp.nonce}", uri="${url}", response="${response}", algorithm=MD5${extra}`;
  }

  private pump(): void {
    while (this.buf.length) {
      if (this.buf[0] === 0x24) {
        // '$' interleaved binary
        if (this.buf.length < 4) return;
        const len = this.buf.readUInt16BE(2);
        if (this.buf.length < 4 + len) return;
        const ch = this.buf[1];
        const pkt = this.buf.subarray(4, 4 + len);
        this.buf = this.buf.subarray(4 + len);
        if (ch === 0) this.handleRTP(pkt);
      } else {
        // RTSP text response
        const he = this.buf.indexOf("\r\n\r\n");
        if (he === -1) return;
        const head = this.buf.subarray(0, he).toString();
        const bl = Number(head.match(/Content-Length:\s*(\d+)/i)?.[1] ?? 0);
        if (this.buf.length < he + 4 + bl) return;
        const body = this.buf.subarray(he + 4, he + 4 + bl).toString();
        this.buf = this.buf.subarray(he + 4 + bl);
        this.handleResponse(head, body);
      }
    }
  }

  private handleResponse(head: string, body: string): void {
    const status = Number(head.split(" ")[1]);
    if (status === 401) {
      if (++this.authRetries > 3) {
        console.error("[rtsp] auth failed — check credentials for", this.host);
        this.sock?.end();
        return;
      }
      this.parseChallenge(head);
      this.send(
        this.lastMethod!,
        this.lastUrl!,
        this.lastMethod === "DESCRIBE" ? { Accept: "application/sdp" } : {},
      );
      return;
    }
    if (status !== 200) {
      console.error(`[rtsp] ${status} on ${this.lastMethod}`);
      this.sock?.end();
      return;
    }
    this.authRetries = 0;

    const s = head.match(/Session:\s*([^;\r\n]+)/i);
    if (s) this.session = s[1]?.trim() ?? null;

    switch (this.lastMethod) {
      case "OPTIONS":
        this.send("DESCRIBE", this.cleanUrl, { Accept: "application/sdp" });
        break;

      case "DESCRIBE": {
        const cb = head.match(/Content-Base:\s*(\S+)/i);
        if (cb?.[1]) this.contentBase = cb[1].replace(/\/$/, "");
        const vid = body.split(/^m=/m).find((x) => x.startsWith("video"));
        const control = vid?.match(/a=control:(\S+)/)?.[1] ?? "trackID=0";
        const trackUrl = /^rtsp:\/\//i.test(control)
          ? control
          : `${this.contentBase}/${control}`;
        const sprop = vid?.match(/sprop-parameter-sets=([^;\s]+)/)?.[1];
        if (sprop) {
          const [a, b] = sprop.split(",").map((x) => Buffer.from(x, "base64"));
          if (a) this.sps = a;
          if (b) this.pps = b;
        }
        this.send("SETUP", trackUrl, {
          Transport: "RTP/AVP/TCP;unicast;interleaved=0-1",
        });
        break;
      }

      case "SETUP":
        this.send("PLAY", this.contentBase, { Range: "npt=0.000-" });
        break;

      case "PLAY":
        console.log(`[rtsp] playing ${this.host}`);
        this.keepAlive = setInterval(
          () => this.send("GET_PARAMETER", this.contentBase),
          25000,
        );
        this.keepAlive.unref();
        break;
    }
  }

  /* --------------------- RTP -> H.264 access units ---------------------- */

  private handleRTP(pkt: Buffer): void {
    if (pkt.length < 12 || (pkt[0] ?? 0) >> 6 !== 2) return;
    let off = 12 + ((pkt[0] ?? 0) & 0x0f) * 4;
    if (((pkt[0] ?? 0) >> 4) & 1) {
      if (pkt.length < off + 4) return;
      off += 4 + pkt.readUInt16BE(off + 2) * 4;
    }
    if (pkt.length <= off) return;
    const p = pkt.subarray(off);
    const t = (p[0] ?? 0) & 0x1f;

    if (t >= 1 && t <= 23) {
      this.onNAL(p);
    } else if (t === 28) {
      // FU-A
      const fu = p[1];
      if ((fu ?? 0) & 0x80) {
        this.fuBuf = Buffer.concat([
          Buffer.from([((p[0] ?? 0) & 0xe0) | ((fu ?? 0) & 0x1f)]),
          p.subarray(2),
        ]);
      } else if (this.fuBuf) {
        this.fuBuf = Buffer.concat([this.fuBuf, p.subarray(2)]);
      }
      if ((fu ?? 0) & 0x40 && this.fuBuf) {
        this.onNAL(this.fuBuf);
        this.fuBuf = null;
      }
    } else if (t === 24) {
      // STAP-A
      let i = 1;
      while (i + 2 <= p.length) {
        const sz = p.readUInt16BE(i);
        i += 2;
        if (i + sz > p.length) break;
        this.onNAL(p.subarray(i, i + sz));
        i += sz;
      }
    }
  }

  private onNAL(nal: Buffer): void {
    const t = (nal[0] ?? 0) & 0x1f;
    if (t === 7) {
      this.sps = Buffer.from(nal);
      return;
    }
    if (t === 8) {
      this.pps = Buffer.from(nal);
      return;
    }
    if (t === 5) {
      // IDR -> key access unit
      if (!this.sps || !this.pps) return;
      const unit = Buffer.concat([
        START,
        this.sps,
        START,
        this.pps,
        START,
        nal,
      ]);
      this.lastKeyUnit = unit; // cache for late joiners
      this.broadcast(true, unit);
    } else if (t === 1) {
      this.broadcast(false, Buffer.concat([START, nal]));
    }
  }

  private broadcast(isKey: boolean, annexb: Buffer): void {
    if (!this.clients.size) return;
    const frame = wsFrame(tagged(isKey, annexb));
    for (const c of this.clients) c.write(frame);
  }
}

/* ============================ public API ================================ */

const attachedServers = new WeakSet<http.Server>();
const sessionsByUrl = new Map<string, RtspSession>();
const sessionsByToken = new Map<string, RtspSession>();

/**
 * Start (or reuse) an RTSP session for rtspUrl and expose it on `server`
 * as a WebSocket endpoint. Returns the token-protected path, e.g.
 * "/stream/6bd1…e2". Multiple calls with the same rtspUrl share one
 * camera connection but get distinct tokens.
 */
export function streamRTSP(server: http.Server, rtspUrl: string): string {
  new URL(rtspUrl); // throws on malformed URL
  if (!/^rtsp:\/\//i.test(rtspUrl))
    throw new Error("rtspUrl must start with rtsp://");

  if (!attachedServers.has(server)) {
    attachUpgradeHandler(server);
    attachAssetHandler(server);
    attachedServers.add(server);
  }

  let sess = sessionsByUrl.get(rtspUrl);
  if (!sess) {
    const created = new RtspSession(rtspUrl, () => {
      sessionsByUrl.delete(rtspUrl);
      for (const [tok, s] of sessionsByToken)
        if (s === created) sessionsByToken.delete(tok);
    });
    sessionsByUrl.set(rtspUrl, created);
    sess = created;
  }

  const token = crypto.randomBytes(16).toString("hex");
  sessionsByToken.set(token, sess);
  return `/stream/${token}`;
}

function attachUpgradeHandler(server: http.Server): void {
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex) => {
    const m = req.url?.match(/^\/stream\/([a-f0-9]{32})$/);
    const sess = m?.[1] ? sessionsByToken.get(m[1]) : undefined;
    const key = req.headers["sec-websocket-key"];
    if (!sess || !key) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sess.addClient(socket);
  });
}

/* ----------------------- browser asset serving ------------------------- */

// The compiled <rtsp-player> element ships beside this file in dist/html.
const PLAYER_DIR = path.join(__dirname, "html");
const DEFAULT_PLAYER_PATH = "/rtsp-player.js";
const ASSET_MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
const assetCache = new Map<string, Buffer>();

/**
 * Absolute path to the bundled `rtsp-player.js` on disk — handy if you want
 * to serve it with your framework's own static-file machinery.
 */
export function playerScriptPath(): string {
  return path.join(PLAYER_DIR, "rtsp-player.js");
}

/**
 * Serve the bundled <rtsp-player> element (and its source map) for a plain
 * `http.IncomingMessage`. Returns `true` if it handled the request (a GET/HEAD
 * for `mountPath` or `mountPath + ".map"`) and wrote the response, `false`
 * otherwise — so you can call it first and fall through to your own routing:
 *
 *   if (serveRtspPlayer(req, res)) return;
 *
 * streamRTSP() wires this up automatically at /rtsp-player.js; use this
 * directly only to change the mount path or serve it without streamRTSP.
 */
export function serveRtspPlayer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mountPath: string = DEFAULT_PLAYER_PATH,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const urlPath = (req.url ?? "").split("?")[0];
  let file: string | null = null;
  if (urlPath === mountPath) file = "rtsp-player.js";
  else if (urlPath === `${mountPath}.map`) file = "rtsp-player.js.map";
  if (!file) return false;

  let data = assetCache.get(file);
  if (!data) {
    try {
      data = fs.readFileSync(path.join(PLAYER_DIR, file));
      assetCache.set(file, data);
    } catch {
      res.writeHead(404).end();
      return true;
    }
  }

  res.writeHead(200, {
    "Content-Type":
      ASSET_MIME[path.extname(file)] ?? "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "public, max-age=3600",
  });
  res.end(req.method === "HEAD" ? undefined : data);
  return true;
}

/**
 * Wrap the server's existing 'request' listeners so /rtsp-player.js is served
 * before falling through to the app. Wrapping (rather than adding a second
 * listener) avoids a double response on that path. Call streamRTSP() after
 * your routes/handler are attached so they are captured here.
 */
function attachAssetHandler(server: http.Server): void {
  const downstream = server.listeners("request") as http.RequestListener[];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    if (serveRtspPlayer(req, res)) return;
    for (const fn of downstream) fn.call(server, req, res);
  });
}
