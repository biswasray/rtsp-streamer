/**
 * rtsp-player.component.ts — Angular equivalent of the <rtsp-player> element
 * (and of the React RtspPlayer.tsx).
 *
 *   <rtsp-player src="rtsp://user:pass@cam/stream1" width="960" autoPlay muted />
 *
 * A standalone component: a <canvas> plus a status overlay (hidden while
 * playing, red on error). All the streaming — token request, WebSocket,
 * WebCodecs decode, canvas — lives in RtspEngine, the same framework-free core
 * the React binding uses; this file is presentation only.
 *
 * Imperative API (grab the instance with a template ref / @ViewChild):
 *   play(src?), stop(), and the read-only `state`.
 *
 * Note: this component's selector is `rtsp-player`, the same tag as the bundled
 * custom element. Use one or the other in a given app, never both — do not also
 * load `/rtsp-player.js` when you use this component.
 */

import {
  AfterViewInit,
  booleanAttribute,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { RtspEngine } from "../react/rtsp-engine.js";
import type { PlayerState } from "../react/rtsp-engine.js";

@Component({
  selector: "rtsp-player",
  standalone: true,
  template: `
    <canvas #canvas class="rtsp-player__canvas"></canvas>
    @if (!hideStatus && state !== "playing") {
      <div class="rtsp-player__status" [class.rtsp-player__status--error]="state === 'error'">
        {{ status }}
      </div>
    }
    <ng-content></ng-content>
  `,
  styles: [
    `
      :host {
        display: inline-block;
        position: relative;
        background: #000;
        border-radius: 10px;
        overflow: hidden;
        line-height: 0;
      }
      .rtsp-player__canvas {
        display: block;
        width: 100%;
        height: 100%;
        aspect-ratio: 16 / 9;
        object-fit: contain;
      }
      .rtsp-player__status {
        position: absolute;
        inset: auto 0 0 0;
        padding: 6px 10px;
        font: 12px/1.4 system-ui, sans-serif;
        color: #8a8a94;
        background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
      }
      .rtsp-player__status--error {
        color: #ff7676;
      }
    `,
  ],
  host: {
    "[attr.data-state]": "state",
    "[style.width]": "css(width)",
    "[style.height]": "css(height)",
  },
})
export class RtspPlayerComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  /** RTSP URL to play (rtsp://…). */
  @Input() src = "";
  /** Play as soon as the view initialises, and whenever `src` changes. */
  @Input({ transform: booleanAttribute }) autoPlay = false;
  /** Mute audio output; toggleable live, like <video>. */
  @Input({ transform: booleanAttribute }) muted = false;
  /** Endpoint that mints a stream token. Default "/api/stream". */
  @Input() api?: string;
  /** CSS width of the video surface (numbers are px). */
  @Input() width?: number | string;
  /** CSS height of the video surface (numbers are px). */
  @Input() height?: number | string;
  /** Hide the built-in status overlay and project your own chrome instead. */
  @Input({ transform: booleanAttribute }) hideStatus = false;

  /** The first decoded frame is on screen. */
  @Output() playing = new EventEmitter<void>();
  /** Playback stopped or the socket closed. */
  @Output() stopped = new EventEmitter<void>();
  /** A request/socket/decode error; the engine is already torn down. */
  @Output() error = new EventEmitter<string>();
  /** Every state transition. */
  @Output() stateChange = new EventEmitter<PlayerState>();

  /** Current player state — bound in the template, readable by the host. */
  state: PlayerState = "idle";
  /** Human-readable status line ("waiting for keyframe…", the error, …). */
  status = "idle";

  @ViewChild("canvas", { static: true })
  private canvasRef!: ElementRef<HTMLCanvasElement>;

  private engine: RtspEngine | null = null;

  ngAfterViewInit(): void {
    // `api` is read through a getter so a changed input applies to the next
    // play() call, mirroring the React binding. An arrow captures the
    // component's `this`, since the options object literal has its own.
    const getApi = (): string | undefined => this.api;
    this.engine = new RtspEngine(this.canvasRef.nativeElement, {
      get api(): string | undefined {
        return getApi();
      },
      muted: this.muted,
      onState: (s, text) => {
        this.state = s;
        this.status = text;
        this.stateChange.emit(s);
      },
      onPlaying: () => this.playing.emit(),
      onStopped: () => this.stopped.emit(),
      onError: (message) => this.error.emit(message),
    });

    if (this.autoPlay && this.src) void this.engine.play(this.src);
  }

  ngOnChanges(changes: SimpleChanges): void {
    const engine = this.engine;
    if (!engine) return; // initial values are handled in ngAfterViewInit

    if (changes["src"]) {
      // A new source replaces what is on screen; an emptied one just stops.
      if (!this.src) engine.stop();
      else if (this.autoPlay || engine.playing) void engine.play(this.src);
    }
    if (changes["muted"]) engine.setMuted(this.muted);
  }

  ngOnDestroy(): void {
    this.engine?.dispose();
    this.engine = null;
  }

  /** Start playback; defaults to the `src` input. */
  play(src?: string): void {
    const url = src ?? this.src;
    if (this.engine && url) void this.engine.play(url);
  }

  /** Stop playback, close the socket, and blank the canvas. */
  stop(): void {
    this.engine?.stop();
  }

  /** Coerce a number|string dimension to a CSS length (numbers are px). */
  protected css(v: number | string | undefined): string | undefined {
    return typeof v === "number" ? `${v}px` : v;
  }
}
