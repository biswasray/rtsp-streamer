/**
 * app.component.ts — the Angular equivalent of examples/react/src/App.tsx.
 *
 * Everything about streaming (token request, WebSocket, WebCodecs decode,
 * canvas) lives inside <rtsp-player>; this component just drives it from a form
 * and mirrors its outputs into a status line.
 *
 * A template ref (#player) is used instead of binding [src], so pressing Play
 * twice with the same URL restarts the stream — an input-only version would see
 * no change. Toggling `muted` applies live (no restart).
 */

import { Component, ViewChild } from "@angular/core";
import { RtspPlayerComponent, type PlayerState } from "rtsp-streamer/angular";

const TEXT: Record<PlayerState, string> = {
  idle: "enter an RTSP URL and press Play",
  connecting: "requesting stream…",
  waiting: "waiting for keyframe…",
  playing: "live",
  error: "",
};

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RtspPlayerComponent],
  template: `
    <form (submit)="play($event, urlInput.value)">
      <input
        #urlInput
        type="text"
        placeholder="rtsp://user:pass@192.168.1.10:554/stream1"
        autocomplete="off"
        spellcheck="false"
        required
      />
      <button type="submit" [disabled]="busy">Play</button>
      <button
        type="button"
        class="stop"
        [disabled]="state === 'idle' || state === 'error'"
        (click)="player.stop()"
      >
        Stop
      </button>
    </form>

    <label class="mute">
      <input
        type="checkbox"
        [checked]="muted"
        (change)="muted = checked($event)"
      />
      muted (applies live — no restart)
    </label>

    <div class="status" [class.err]="error !== null">
      {{ error ?? TEXT[state] }}
    </div>

    <!-- hideStatus: the page already has its own status line above. -->
    <rtsp-player
      #player
      [muted]="muted"
      hideStatus
      class="player"
      (stateChange)="onState($event)"
      (error)="error = $event"
    ></rtsp-player>
  `,
})
export class AppComponent {
  @ViewChild("player") private readonly player!: RtspPlayerComponent;

  protected readonly TEXT = TEXT;
  protected muted = true;
  protected state: PlayerState = "idle";
  protected error: string | null = null;

  protected get busy(): boolean {
    return this.state === "connecting" || this.state === "waiting";
  }

  protected play(event: Event, url: string): void {
    event.preventDefault();
    this.player.play(url.trim());
  }

  protected onState(state: PlayerState): void {
    this.state = state;
    if (state !== "error") this.error = null;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
