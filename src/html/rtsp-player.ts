/**
 * rtsp-player.ts — <rtsp-player> custom element (no libraries).
 *
 *   <script type="module" src="rtsp-player.js"></script>
 *   <rtsp-player src="rtsp://user:pass@cam/stream1" width="960" autoplay muted>
 *   </rtsp-player>
 *
 * Attributes (all reflected as properties):
 *   src       RTSP URL to play (rtsp://…)
 *   width     CSS width  of the video surface (px if unitless)
 *   height    CSS height of the video surface (px if unitless)
 *   autoplay  play as soon as the element connects / src changes
 *   muted     mute audio output (toggleable live, like <video>)
 *   api       endpoint that mints a stream token (default "/api/stream")
 *
 * Methods:
 *   play(src?)  resolve a token, open the WebSocket, start decoding
 *   stop()      close the socket + decoders and blank the canvas
 *
 * Events: "playing", "stopped", "error" (detail: { message }),
 *         "statechange" (detail: { state })
 *
 * Talks to the server exposed by streamRtsp():
 *   1. POST <api> { rtspUrl }  ->  { path: "/stream/<token>" }
 *   2. WebSocket on that path; first byte of each binary message is the type
 *      (mirrored in src/index.ts):
 *        0 delta video / 1 key video  [Annex-B H.264 access unit]
 *        2 audio config               [JSON AudioDecoderConfig-ish]
 *        3 audio frame                [AAC AU / G.711 bytes / Opus packet]
 *   3. Video: WebCodecs VideoDecoder -> <canvas>. Audio: WebCodecs
 *      AudioDecoder -> Web Audio, scheduled sequentially through a GainNode
 *      (which is what `muted` drives). Audio failures never stop the video —
 *      the element just degrades to a silent player.
 *
 * Autoplay policy: browsers keep an AudioContext suspended until a user
 * gesture. play() attempts resume(); if the context stays suspended (e.g.
 * `autoplay` without any interaction) the first pointerdown resumes it.
 */

export type PlayerState =
  "idle" | "connecting" | "waiting" | "playing" | "error";

export interface RtspPlayerEventMap {
  playing: CustomEvent<undefined>;
  stopped: CustomEvent<undefined>;
  error: CustomEvent<{ message: string }>;
  statechange: CustomEvent<{ state: PlayerState }>;
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

const STYLE = `
  :host {
    display: inline-block;
    position: relative;
    background: #000;
    border-radius: 10px;
    overflow: hidden;
    line-height: 0;
  }
  :host([hidden]) { display: none; }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    aspect-ratio: 16 / 9;
    object-fit: contain;
  }
  #status {
    position: absolute;
    inset: auto 0 0 0;
    padding: 6px 10px;
    font: 12px/1.4 system-ui, sans-serif;
    color: #8a8a94;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
  }
  #status[data-state="playing"] { display: none; }
  #status[data-state="error"] { color: #ff7676; }
`;

export class RtspPlayer extends HTMLElement {
  static readonly observedAttributes = [
    "src",
    "width",
    "height",
    "autoplay",
    "muted",
  ];

  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #statusEl: HTMLDivElement;

  #ws: WebSocket | null = null;
  #decoder: VideoDecoder | null = null;
  #gotKey = false;
  #frameNo = 0;
  #state: PlayerState = "idle";
  /** Guards against a late play() resolving after a newer play()/stop(). */
  #run = 0;

  #audioDecoder: AudioDecoder | null = null;
  #audioCtx: AudioContext | null = null;
  #audioGain: GainNode | null = null;
  #audioCfg: AudioConfigMessage | null = null;
  #audioPlayhead = 0; // AudioContext time the next buffer starts at
  #audioTs = 0; // synthetic µs timestamp fed to the decoder
  #resumeOnGesture: (() => void) | null = null;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${STYLE}</style>
      <canvas part="canvas"></canvas>
      <div id="status" part="status"></div>
    `;
    this.#canvas = root.querySelector("canvas")!;
    this.#statusEl = root.querySelector("#status")!;
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("<rtsp-player>: 2d canvas context unavailable");
    this.#ctx = ctx;
    this.#setState("idle", "idle");
  }

  /* ---------------------------- properties ----------------------------- */

  get src(): string {
    return this.getAttribute("src") ?? "";
  }
  set src(v: string | null) {
    if (v == null || v === "") this.removeAttribute("src");
    else this.setAttribute("src", v);
  }

  get width(): string | null {
    return this.getAttribute("width");
  }
  set width(v: string | number | null) {
    if (v == null) this.removeAttribute("width");
    else this.setAttribute("width", String(v));
  }

  get height(): string | null {
    return this.getAttribute("height");
  }
  set height(v: string | number | null) {
    if (v == null) this.removeAttribute("height");
    else this.setAttribute("height", String(v));
  }

  get autoplay(): boolean {
    return this.hasAttribute("autoplay");
  }
  set autoplay(v: boolean) {
    this.toggleAttribute("autoplay", Boolean(v));
  }

  get muted(): boolean {
    return this.hasAttribute("muted");
  }
  set muted(v: boolean) {
    this.toggleAttribute("muted", Boolean(v));
  }

  get api(): string {
    return this.getAttribute("api") ?? "/api/stream";
  }
  set api(v: string) {
    this.setAttribute("api", v);
  }

  get state(): PlayerState {
    return this.#state;
  }

  get playing(): boolean {
    return this.#state === "playing";
  }

  /* ------------------------- lifecycle callbacks ------------------------ */

  connectedCallback(): void {
    this.#applySize();
    if (this.autoplay && this.src) void this.play();
  }

  disconnectedCallback(): void {
    this.stop();
  }

  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    if (oldValue === newValue) return;
    if (name === "width" || name === "height") {
      this.#applySize();
      return;
    }
    if (name === "muted") {
      if (this.#audioGain)
        this.#audioGain.gain.value = newValue !== null ? 0 : 1;
      return;
    }
    if (name !== "src" || !this.isConnected) return;
    // A new source replaces whatever is on screen; an emptied one just stops.
    if (!newValue) this.stop();
    else if (this.autoplay || this.playing) void this.play();
  }

  /* ------------------------------ methods ------------------------------ */

  /**
   * Start playback. Pass a URL to override (and adopt) the `src` attribute.
   * Resolves once the WebSocket is open — frames arrive asynchronously after.
   */
  async play(src?: string): Promise<void> {
    if (src !== undefined) {
      // Skip the attribute callback's re-entrant play(): we are already here.
      const nested = ++this.#run;
      this.setAttribute("src", src);
      if (nested !== this.#run) return; // a nested play() already took over
    }

    const rtspUrl = this.src.trim();
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
      const res = await fetch(this.api, {
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
      this.#emit("stopped");
    };
  }

  /** Stop playback, close the camera socket, and blank the canvas. */
  stop(): void {
    if (this.#state === "idle") return;
    this.#run++;
    this.#teardown();
    this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    this.#setState("idle", "stopped");
    this.#emit("stopped");
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
      this.#emit("playing");
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
    gain.gain.value = this.muted ? 0 : 1;
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
        console.warn("<rtsp-player> audio disabled:", e.message);
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
      console.warn("<rtsp-player> audio codec unsupported:", cfg.codec, e);
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
    this.#emit("error", { message });
  }

  #setState(state: PlayerState, text: string): void {
    this.#state = state;
    this.#statusEl.dataset["state"] = state;
    this.#statusEl.textContent = text;
    this.#emit("statechange", { state });
  }

  #emit<K extends keyof RtspPlayerEventMap>(
    type: K,
    detail?: RtspPlayerEventMap[K]["detail"],
  ): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #applySize(): void {
    const css = (v: string): string => (/^\d+$/.test(v) ? `${v}px` : v);
    const w = this.getAttribute("width");
    const h = this.getAttribute("height");
    this.style.width = w ? css(w) : "";
    this.style.height = h ? css(h) : "";
  }

  /* --------------------- typed listener overloads ----------------------- */

  override addEventListener<K extends keyof RtspPlayerEventMap>(
    type: K,
    listener: (this: RtspPlayer, ev: RtspPlayerEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }

  override removeEventListener<K extends keyof RtspPlayerEventMap>(
    type: K,
    listener: (this: RtspPlayer, ev: RtspPlayerEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }
}

customElements.define("rtsp-player", RtspPlayer);

declare global {
  interface HTMLElementTagNameMap {
    "rtsp-player": RtspPlayer;
  }
}
