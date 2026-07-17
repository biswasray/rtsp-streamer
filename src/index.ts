/**
 * rtsp-stream.ts — Reusable, zero-dependency RTSP -> WebSocket streaming module.
 *
 *   import { streamRtsp } from './rtsp-stream.ts';
 *   const path = streamRtsp(server, 'rtsp://user:pass@cam/stream1');
 *   // -> "/stream/3f9c2e...b1" (WebSocket endpoint, token-protected)
 *
 * Behaviour:
 *  - Attaches ONE 'upgrade' handler to the given http.Server (idempotent).
 *  - Serves the bundled <rtsp-player> browser element at /rtsp-player.js
 *    (inlined at build time), so pages can just
 *    `<script type="module" src="/rtsp-player.js">` — no copy step. See
 *    serveRtspPlayer() to mount it yourself at a different path.
 *  - One RTSP session per unique rtspUrl (many viewers share one camera
 *    connection); every streamRtsp() call returns a fresh access token.
 *  - New viewers immediately receive the last cached keyframe (SPS+PPS+IDR),
 *    so video starts without waiting for the camera's next IDR.
 *  - If the SDP advertises an audio track in a supported codec (AAC via
 *    mpeg4-generic, G.711 PCMU/PCMA, or Opus) it is SETUP on interleaved
 *    channels 2-3 and forwarded too; audio failures degrade to video-only.
 *  - When a session has had no viewers for IDLE_MS it sends TEARDOWN and
 *    frees itself (its tokens become invalid).
 *
 * Wire format per WebSocket binary message — first byte is the type:
 *   0  delta video   [Annex-B H.264 access unit]
 *   1  key video     [Annex-B H.264 access unit]
 *   2  audio config  [UTF-8 JSON: { codec, sampleRate, numberOfChannels,
 *                     description? (base64) } — WebCodecs AudioDecoderConfig]
 *   3  audio frame   [one encoded frame: raw AAC AU / G.711 bytes / Opus pkt]
 *
 * No cross-track timestamps are carried: this is a live view, both tracks are
 * forwarded as they arrive, so A/V sync is delivery-order (typically < 100ms).
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import type * as http from "node:http";
import type { Duplex } from "node:stream";
import {
  RTSP_PLAYER_JS,
  RTSP_PLAYER_JS_MAP,
} from "./player-asset.generated.js";

const START = Buffer.from([0, 0, 0, 1]);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const IDLE_MS = 60_000;

// WebSocket message types (first payload byte) — mirrored in rtsp-player.ts.
const MSG_VIDEO_DELTA = 0;
const MSG_VIDEO_KEY = 1;
const MSG_AUDIO_CONFIG = 2;
const MSG_AUDIO = 3;

interface DigestParams {
  realm: string;
  nonce: string;
  qop: string | null;
  opaque: string | null;
}

interface AudioTrack {
  /** WebCodecs codec string: "mp4a.40.2" | "ulaw" | "alaw" | "opus". */
  codec: string;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig from fmtp `config=` (AAC only). */
  description: Buffer | null;
  /** Absolute SETUP URL, resolved against Content-Base. */
  trackUrl: string;
  /** RTP payload needs AU-header depacketization (AAC / RFC 3640). */
  aac: boolean;
  /** Bits of each AU-header holding the AU size (fmtp sizelength, def. 13). */
  sizeLength: number;
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

function tagged(type: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), payload]);
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

  // Access unit being assembled: one frame may span several NALs (x264
  // sliced-threads, e.g. ffmpeg -tune zerolatency, emits multiple slices).
  private auNals: Buffer[] = [];
  private auHasIdr = false;
  private auRtpTs = -1;

  private audio: AudioTrack | null = null;
  private audioSetUp = false; // audio SETUP request sent this connection
  private audioConfigMsg: Buffer | null = null; // cached tagged() message

  // Actual interleaved RTP channels, learned from each SETUP response's
  // Transport header (the server, not the client, picks them — RFC 2326).
  // Default to our requested channels for servers that omit them.
  private videoCh = 0;
  private audioCh = 2;

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

    // Tell the newcomer how to decode audio before any audio frame arrives.
    if (this.audioConfigMsg) socket.write(wsFrame(this.audioConfigMsg));
    // Instant start: replay the last keyframe access unit to the newcomer.
    if (this.lastKeyUnit)
      socket.write(wsFrame(tagged(MSG_VIDEO_KEY, this.lastKeyUnit)));

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
    this.audioSetUp = false; // re-negotiated by the next DESCRIBE/SETUP
    this.videoCh = 0;
    this.audioCh = 2;
    this.auNals = [];
    this.auHasIdr = false;
    this.auRtpTs = -1;

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

  /**
   * Pick a supported codec out of an SDP audio media section (the text after
   * "m=audio ..."). Returns null when nothing we can forward is offered.
   */
  private parseAudio(sec: string): AudioTrack | null {
    const control = sec.match(/a=control:(\S+)/)?.[1] ?? "trackID=1";
    const trackUrl = /^rtsp:\/\//i.test(control)
      ? control
      : `${this.contentBase}/${control}`;

    for (const m of sec.matchAll(
      /a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)\/(\d+)(?:\/(\d+))?/g,
    )) {
      const enc = m[2]!.toLowerCase();
      const sampleRate = Number(m[3]);
      const channels = m[4] ? Number(m[4]) : 1;
      const base = { sampleRate, channels, trackUrl, sizeLength: 13 };
      if (enc === "mpeg4-generic") {
        // AAC (RFC 3640). The AudioSpecificConfig comes from fmtp config=.
        const fmtp =
          sec.match(new RegExp(`a=fmtp:${m[1]}\\s+([^\\r\\n]+)`))?.[1] ?? "";
        const cfg = fmtp.match(/config=([0-9A-Fa-f]+)/)?.[1];
        if (!cfg) continue;
        return {
          ...base,
          codec: "mp4a.40.2",
          description: Buffer.from(cfg, "hex"),
          aac: true,
          sizeLength: Number(fmtp.match(/sizelength=(\d+)/i)?.[1] ?? 13),
        };
      }
      if (enc === "pcmu")
        return { ...base, codec: "ulaw", description: null, aac: false };
      if (enc === "pcma")
        return { ...base, codec: "alaw", description: null, aac: false };
      if (enc === "opus")
        return { ...base, codec: "opus", description: null, aac: false };
    }

    // Static payload types (no rtpmap line): 0 = PCMU/8000, 8 = PCMA/8000.
    const types = sec.match(/^audio\s+\d+\s+\S+\s+([\d ]+)/)?.[1]?.split(" ");
    const common = {
      sampleRate: 8000,
      channels: 1,
      description: null,
      trackUrl,
      aac: false,
      sizeLength: 13,
    };
    if (types?.includes("0")) return { ...common, codec: "ulaw" };
    if (types?.includes("8")) return { ...common, codec: "alaw" };
    return null;
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
        if (ch === this.videoCh) this.handleRTP(pkt);
        else if (this.audio && ch === this.audioCh) this.handleAudioRTP(pkt);
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
      // A camera that refuses the audio SETUP shouldn't cost us the video.
      if (this.lastMethod === "SETUP" && this.audioSetUp && this.audio) {
        console.warn(`[rtsp] ${status} on audio SETUP — continuing video-only`);
        this.audio = null;
        this.audioConfigMsg = null;
        this.send("PLAY", this.contentBase, { Range: "npt=0.000-" });
        return;
      }
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
        const sections = body.split(/^m=/m);
        const vid = sections.find((x) => x.startsWith("video"));
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

        const aud = sections.find((x) => x.startsWith("audio"));
        this.audio = aud ? this.parseAudio(aud) : null;
        if (this.audio) {
          this.audioConfigMsg = tagged(
            MSG_AUDIO_CONFIG,
            Buffer.from(
              JSON.stringify({
                codec: this.audio.codec,
                sampleRate: this.audio.sampleRate,
                numberOfChannels: this.audio.channels,
                ...(this.audio.description
                  ? { description: this.audio.description.toString("base64") }
                  : {}),
              }),
            ),
          );
          // Existing viewers (camera reconnect) need the new config too.
          for (const c of this.clients) c.write(wsFrame(this.audioConfigMsg));
          console.log(
            `[rtsp] audio: ${this.audio.codec} ${this.audio.sampleRate}Hz x${this.audio.channels} ${this.host}`,
          );
        } else {
          this.audioConfigMsg = null;
        }

        this.send("SETUP", trackUrl, {
          Transport: "RTP/AVP/TCP;unicast;interleaved=0-1",
        });
        break;
      }

      case "SETUP": {
        // The server picks the interleaved channels and echoes them here; trust
        // that, not our request (ffmpeg may order audio before video in the SDP,
        // so audio can land on 0-1 and video on 2-3). Route by the real numbers.
        const rtpCh = Number(head.match(/interleaved=(\d+)/i)?.[1] ?? NaN);
        if (this.audio && !this.audioSetUp) {
          // Response to the video SETUP -> now SETUP audio, then PLAY.
          if (Number.isFinite(rtpCh)) this.videoCh = rtpCh;
          this.audioSetUp = true;
          this.send("SETUP", this.audio.trackUrl, {
            Transport: "RTP/AVP/TCP;unicast;interleaved=2-3",
          });
        } else {
          // Response to the audio SETUP (or the sole video SETUP when muted).
          if (Number.isFinite(rtpCh)) {
            if (this.audio) this.audioCh = rtpCh;
            else this.videoCh = rtpCh;
          }
          this.send("PLAY", this.contentBase, { Range: "npt=0.000-" });
        }
        break;
      }

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

  /* ---------------------- RTP -> media frames --------------------------- */

  /** Strip the RTP fixed header, CSRCs and extension; null if malformed. */
  private rtpPayload(pkt: Buffer): Buffer | null {
    if (pkt.length < 12 || (pkt[0] ?? 0) >> 6 !== 2) return null;
    let off = 12 + ((pkt[0] ?? 0) & 0x0f) * 4;
    if (((pkt[0] ?? 0) >> 4) & 1) {
      if (pkt.length < off + 4) return null;
      off += 4 + pkt.readUInt16BE(off + 2) * 4;
    }
    if (pkt.length <= off) return null;
    return pkt.subarray(off);
  }

  private handleRTP(pkt: Buffer): void {
    const p = this.rtpPayload(pkt);
    if (!p) return;

    // RFC 6184: one access unit may span several packets and several slices.
    // Slices are collected until the marker bit (last packet of the AU); a
    // change of RTP timestamp also flushes, for encoders that skip the marker.
    const rtpTs = pkt.readUInt32BE(4);
    if (this.auNals.length && rtpTs !== this.auRtpTs) this.flushAU();
    this.auRtpTs = rtpTs;

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

    if ((pkt[1] ?? 0) & 0x80) this.flushAU(); // marker: AU complete
  }

  private handleAudioRTP(pkt: Buffer): void {
    const a = this.audio;
    if (!a) return;
    const p = this.rtpPayload(pkt);
    if (!p) return;

    if (!a.aac) {
      // G.711 / Opus: the payload is exactly one frame.
      this.broadcast(MSG_AUDIO, p);
      return;
    }

    // AAC (RFC 3640 AAC-hbr): [16-bit AU-headers length in bits][AU headers]
    // [AUs]. Each AU header carries the AU size in its top `sizeLength` bits.
    if (p.length < 2) return;
    const headersLen = (p.readUInt16BE(0) + 7) >> 3;
    let hdr = 2;
    let off = 2 + headersLen;
    while (hdr + 2 <= 2 + headersLen && off < p.length) {
      const size = p.readUInt16BE(hdr) >> (16 - a.sizeLength);
      if (size === 0 || off + size > p.length) break;
      this.broadcast(MSG_AUDIO, p.subarray(off, off + size));
      hdr += 2;
      off += size;
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
    if (t !== 5 && t !== 1) return; // SEI/AUD/filler — not part of the AU
    if (t === 5) this.auHasIdr = true;
    this.auNals.push(Buffer.from(nal)); // slice of the current access unit
  }

  /** Emit the collected slices as ONE complete access unit. */
  private flushAU(): void {
    if (!this.auNals.length) return;
    const nals = this.auNals;
    this.auNals = [];
    const isKey = this.auHasIdr;
    this.auHasIdr = false;
    if (isKey && (!this.sps || !this.pps)) return; // not decodable yet
    const parts: Buffer[] = isKey ? [START, this.sps!, START, this.pps!] : [];
    for (const n of nals) parts.push(START, n);
    const unit = Buffer.concat(parts);
    if (isKey) this.lastKeyUnit = unit; // cache for late joiners
    this.broadcast(isKey ? MSG_VIDEO_KEY : MSG_VIDEO_DELTA, unit);
  }

  private broadcast(type: number, payload: Buffer): void {
    if (!this.clients.size) return;
    const frame = wsFrame(tagged(type, payload));
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
export function streamRtsp(server: http.Server, rtspUrl: string): string {
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

const DEFAULT_PLAYER_PATH = "/rtsp-player.js";

// The compiled <rtsp-player> element is inlined at build time (see
// scripts/build-assets.mjs) rather than read from disk, so it serves the same
// bytes from both the CJS and ESM builds without any __dirname / import.meta
// path resolution.
const ASSETS: Record<string, { body: Buffer; type: string }> = {
  "rtsp-player.js": {
    body: Buffer.from(RTSP_PLAYER_JS),
    type: "text/javascript; charset=utf-8",
  },
  "rtsp-player.js.map": {
    body: Buffer.from(RTSP_PLAYER_JS_MAP),
    type: "application/json; charset=utf-8",
  },
};

/**
 * Serve the bundled <rtsp-player> element (and its source map) for a plain
 * `http.IncomingMessage`. Returns `true` if it handled the request (a GET/HEAD
 * for `mountPath` or `mountPath + ".map"`) and wrote the response, `false`
 * otherwise — so you can call it first and fall through to your own routing:
 *
 *   if (serveRtspPlayer(req, res)) return;
 *
 * streamRtsp() wires this up automatically at /rtsp-player.js; use this
 * directly only to change the mount path or serve it without streamRtsp.
 */
export function serveRtspPlayer(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  mountPath: string = DEFAULT_PLAYER_PATH,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const urlPath = (req.url ?? "").split("?")[0];
  let key: string | null = null;
  if (urlPath === mountPath) key = "rtsp-player.js";
  else if (urlPath === `${mountPath}.map`) key = "rtsp-player.js.map";
  if (!key) return false;

  const asset = ASSETS[key]!;
  res.writeHead(200, {
    "Content-Type": asset.type,
    "Content-Length": asset.body.length,
    "Cache-Control": "public, max-age=3600",
  });
  res.end(req.method === "HEAD" ? undefined : asset.body);
  return true;
}

/**
 * Wrap the server's existing 'request' listeners so /rtsp-player.js is served
 * before falling through to the app. Wrapping (rather than adding a second
 * listener) avoids a double response on that path. Call streamRtsp() after
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
