/**
 * rtsp-engine.ts — the <rtsp-player> playback core, without the custom element.
 *
 * Same wire protocol and decoding pipeline as src/html/rtsp-player.ts; the only
 * difference is that the DOM surface is injected (a <canvas> the caller owns)
 * and state changes are reported through callbacks instead of DOM events. React
 * renders the chrome; this class owns the socket, the decoders and Web Audio.
 *
 *   const engine = new RtspEngine(canvas, { onState: … });
 *   await engine.play("rtsp://user:pass@cam/stream1");
 *   engine.stop();
 *
 * Protocol (first byte of each binary message, mirrored in src/index.ts):
 *   0 delta video / 1 key video  [Annex-B H.264 access unit]
 *   2 audio config               [JSON AudioDecoderConfig-ish]
 *   3 audio frame                [AAC AU / G.711 bytes / Opus packet]
 *
 * Audio failures never stop the video — playback degrades to a silent stream.
 */

export type PlayerState =
  "idle" | "connecting" | "waiting" | "playing" | "error";

export interface RtspEngineOptions {
  /** Endpoint that mints a stream token. Default "/api/stream". */
  api?: string;
  /** Start muted; change later with setMuted(). */
  muted?: boolean;
  /** Every state transition, with the human-readable status text. */
  onState?: (state: PlayerState, text: string) => void;
  /** First decoded frame is on screen. */
  onPlaying?: () => void;
  /** Socket closed or stop() called. */
  onStopped?: () => void;
  /** Fatal error; the engine is already torn down when this fires. */
  onError?: (message: string) => void;
}

interface StreamResponse {
  path?: string;
  error?: string;
}

/** Type-2 wire message: how to configure the AudioDecoder. */
interface AudioConfigMessage {
  codec: string; // "mp4a.40.2" | "ulaw" | "alaw" | "opus"
  sampleRate: number;
  numberOfChannels: number;
  description?: string; // base64 AudioSpecificConfig (AAC only)
}

// Wire message types (first payload byte) — mirrored in src/index.ts.
const MSG_VIDEO_KEY = 1;
const MSG_AUDIO_CONFIG = 2;
const MSG_AUDIO = 3;

export class RtspEngine {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #opts: RtspEngineOptions;

  #ws: WebSocket | null = null;
  #decoder: VideoDecoder | null = null;
  #gotKey = false;
  #frameNo = 0;
  #state: PlayerState = "idle";
  #muted: boolean;
  /** Guards against a late play() resolving after a newer play()/stop(). */
  #run = 0;
  #disposed = false;

  #audioDecoder: AudioDecoder | null = null;
  #audioCtx: AudioContext | null = null;
  #audioGain: GainNode | null = null;
  #audioCfg: AudioConfigMessage | null = null;
  #audioPlayhead = 0; // AudioContext time the next buffer starts at
  #audioTs = 0; // synthetic µs timestamp fed to the decoder
  #resumeOnGesture: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, options: RtspEngineOptions = {}) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("RtspEngine: 2d canvas context unavailable");
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#opts = options;
    this.#muted = options.muted ?? false;
  }

  get state(): PlayerState {
    return this.#state;
  }

  get playing(): boolean {
    return this.#state === "playing";
  }

  /** Mute/unmute live, like <video>. */
  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (this.#audioGain) this.#audioGain.gain.value = muted ? 0 : 1;
  }

  /**
   * Start playback of an rtsp:// URL. Resolves once the WebSocket is open —
   * frames arrive asynchronously after that.
   */
  async play(src: string): Promise<void> {
    const rtspUrl = src.trim();
    if (!rtspUrl) {
      this.#fail("src (rtsp://…) is required");
      return;
    }
    if (!("VideoDecoder" in window)) {
      this.#fail("WebCodecs is not supported in this browser");
      return;
    }

    this.#teardown();
    const run = ++this.#run;
    this.#setState("connecting", "requesting stream…");

    let path: string;
    try {
      const res = await fetch(this.#opts.api ?? "/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rtspUrl }),
      });
      const body = (await res.json()) as StreamResponse;
      if (!res.ok) throw new Error(body.error ?? `server error ${res.status}`);
      if (!body.path) throw new Error("server returned no stream path");
      path = body.path; // e.g. "/stream/6bd1…e2"
    } catch (e) {
      if (run === this.#run) this.#fail((e as Error).message);
      return;
    }
    if (run !== this.#run) return; // superseded while awaiting

    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    const ws = new WebSocket(proto + location.host + path);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;

    ws.onopen = (): void => this.#setState("waiting", "waiting for keyframe…");
    ws.onmessage = (ev: MessageEvent<ArrayBuffer>): void => this.#onMessage(ev);
    ws.onerror = (): void => this.#fail("websocket error");
    ws.onclose = (): void => {
      if (this.#ws !== ws) return; // an old socket we already replaced
      this.#teardown();
      this.#setState("idle", "disconnected");
      if (!this.#disposed) this.#opts.onStopped?.();
    };
  }

  /** Stop playback, close the camera socket, and blank the canvas. */
  stop(): void {
    if (this.#state === "idle") return;
    this.#run++;
    this.#teardown();
    this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    this.#setState("idle", "stopped");
    if (!this.#disposed) this.#opts.onStopped?.();
  }

  /**
   * Release everything and stop emitting callbacks. Call from an effect
   * cleanup — the component is unmounting and must not hear from us again.
   */
  dispose(): void {
    this.#run++;
    this.#disposed = true;
    this.#teardown();
    this.#state = "idle";
  }

  /* ------------------------------ internals ----------------------------- */

  #teardown(): void {
    if (this.#ws) {
      const ws = this.#ws;
      this.#ws = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    }
    if (this.#decoder && this.#decoder.state !== "closed")
      this.#decoder.close();
    this.#decoder = null;
    this.#gotKey = false;
    this.#frameNo = 0;
    this.#teardownAudio();
  }

  #onMessage(ev: MessageEvent<ArrayBuffer>): void {
    const u8 = new Uint8Array(ev.data);
    const type = u8[0];
    const data = u8.subarray(1);

    if (type === MSG_AUDIO_CONFIG) {
      this.#initAudio(data);
      return;
    }
    if (type === MSG_AUDIO) {
      this.#onAudioFrame(data);
      return;
    }

    const isKey = type === MSG_VIDEO_KEY;
    if (!this.#decoder) {
      if (!isKey) return;
      // A key unit starts [00 00 00 01][SPS] — the profile/compat/level bytes
      // follow the 1-byte NAL header, so they sit at offsets 5..7.
      if (data.length < 8) return;
      const hex = (b: number): string => b.toString(16).padStart(2, "0");
      this.#initDecoder(
        `avc1.${hex(data[5]!)}${hex(data[6]!)}${hex(data[7]!)}`,
      );
    }
    if (!this.#gotKey && !isKey) return; // must start on a keyframe
    this.#gotKey = true;

    this.#decoder!.decode(
      new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: this.#frameNo++ * 33333, // monotonic µs (~30 fps)
        data,
      }),
    );
    if (this.#state !== "playing") {
      this.#setState("playing", "live");
      this.#opts.onPlaying?.();
    }
  }

  #initDecoder(codec: string): void {
    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this.#canvas.width !== frame.displayWidth) {
          this.#canvas.width = frame.displayWidth;
          this.#canvas.height = frame.displayHeight;
        }
        this.#ctx.drawImage(frame, 0, 0);
        frame.close();
      },
      error: (e: DOMException) =>
        this.#fail(`decode error: ${e.message} [${codec}]`),
    });
    // No "description" in the config => the decoder accepts Annex-B directly.
    decoder.configure({ codec, optimizeForLatency: true });
    this.#decoder = decoder;

    // Advisory: turn an eventual bare "Decoding error" into a useful message.
    // Typical trap: 4:2:2 H.264 (profile 7a) from ffmpeg webcam captures
    // without -pix_fmt yuv420p — browsers only decode 4:2:0 profiles.
    void VideoDecoder.isConfigSupported({ codec })
      .then((s) => {
        if (!s.supported && this.#decoder === decoder)
          this.#fail(
            `H.264 profile ${codec} is not supported by this browser — ` +
              "re-encode as 4:2:0 (e.g. ffmpeg -pix_fmt yuv420p)",
          );
      })
      .catch(() => {});
  }

  /* ------------------------------- audio -------------------------------- */

  #initAudio(raw: Uint8Array): void {
    if (this.#audioDecoder || !("AudioDecoder" in window)) return;
    let cfg: AudioConfigMessage;
    try {
      cfg = JSON.parse(new TextDecoder().decode(raw)) as AudioConfigMessage;
    } catch {
      return;
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: cfg.sampleRate });
    } catch {
      ctx = new AudioContext(); // rate unsupported -> let Web Audio resample
    }
    const gain = ctx.createGain();
    gain.gain.value = this.#muted ? 0 : 1;
    gain.connect(ctx.destination);

    void ctx.resume();
    if (ctx.state === "suspended") {
      // Autoplay policy: wait for the first user gesture, then unmute output.
      this.#resumeOnGesture = (): void => {
        void this.#audioCtx?.resume();
        this.#resumeOnGesture = null;
      };
      document.addEventListener("pointerdown", this.#resumeOnGesture, {
        once: true,
      });
    }

    const decoder = new AudioDecoder({
      output: (frame: AudioData) => this.#playAudio(frame),
      // Audio trouble should never take the picture down with it.
      error: (e: DOMException) => {
        console.warn("RtspEngine: audio disabled:", e.message);
        this.#teardownAudio();
      },
    });
    try {
      decoder.configure({
        codec: cfg.codec,
        sampleRate: cfg.sampleRate,
        numberOfChannels: cfg.numberOfChannels,
        ...(cfg.description
          ? {
              description: Uint8Array.from(atob(cfg.description), (c) =>
                c.charCodeAt(0),
              ),
            }
          : {}),
      });
    } catch (e) {
      console.warn("RtspEngine: audio codec unsupported:", cfg.codec, e);
      void ctx.close();
      return;
    }

    this.#audioCtx = ctx;
    this.#audioGain = gain;
    this.#audioDecoder = decoder;
    this.#audioCfg = cfg;
  }

  #onAudioFrame(data: Uint8Array): void {
    const decoder = this.#audioDecoder;
    if (!decoder || decoder.state !== "configured") return;
    try {
      decoder.decode(
        new EncodedAudioChunk({
          type: "key", // every AAC/G.711/Opus frame decodes independently
          timestamp: this.#audioTs,
          data,
        }),
      );
    } catch {
      return;
    }
    this.#audioTs += this.#frameDurationUs(data.byteLength);
  }

  /** Nominal duration of one encoded frame, µs (decoder pacing only). */
  #frameDurationUs(bytes: number): number {
    const cfg = this.#audioCfg!;
    if (cfg.codec === "mp4a.40.2") return 1024e6 / cfg.sampleRate; // AAC AU
    if (cfg.codec === "opus") return 20_000; // typical Opus frame
    return (bytes * 1e6) / (cfg.sampleRate * cfg.numberOfChannels); // G.711
  }

  /** Schedule a decoded AudioData right after the previously queued one. */
  #playAudio(frame: AudioData): void {
    const ctx = this.#audioCtx;
    const gain = this.#audioGain;
    if (!ctx || !gain || ctx.state === "closed") {
      frame.close();
      return;
    }
    let buf: AudioBuffer;
    try {
      buf = ctx.createBuffer(
        frame.numberOfChannels,
        frame.numberOfFrames,
        frame.sampleRate,
      );
      const ch = new Float32Array(frame.numberOfFrames);
      for (let c = 0; c < frame.numberOfChannels; c++) {
        frame.copyTo(ch, { planeIndex: c, format: "f32-planar" });
        buf.copyToChannel(ch, c);
      }
    } catch {
      frame.close();
      return;
    }
    frame.close();

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    // Chain buffers back to back; on underrun restart slightly ahead of "now".
    const at = Math.max(ctx.currentTime + 0.05, this.#audioPlayhead);
    src.start(at);
    this.#audioPlayhead = at + buf.duration;
  }

  #teardownAudio(): void {
    if (this.#audioDecoder && this.#audioDecoder.state !== "closed")
      this.#audioDecoder.close();
    this.#audioDecoder = null;
    if (this.#resumeOnGesture) {
      document.removeEventListener("pointerdown", this.#resumeOnGesture);
      this.#resumeOnGesture = null;
    }
    if (this.#audioCtx && this.#audioCtx.state !== "closed")
      void this.#audioCtx.close();
    this.#audioCtx = null;
    this.#audioGain = null;
    this.#audioCfg = null;
    this.#audioPlayhead = 0;
    this.#audioTs = 0;
  }

  #fail(message: string): void {
    this.#run++;
    this.#teardown();
    this.#setState("error", message);
    if (!this.#disposed) this.#opts.onError?.(message);
  }

  #setState(state: PlayerState, text: string): void {
    if (this.#disposed) return;
    this.#state = state;
    this.#opts.onState?.(state, text);
  }
}
