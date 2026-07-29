import { PlayerPanel } from "./player-panel";

/**
 * app/page.tsx — a Server Component. It renders on the server (this text is in
 * the initial HTML, no JS needed) and hosts the client <PlayerPanel>, whose
 * "use client" boundary comes in through the rtsp-streamer/next/client import.
 */
export default function Page() {
  return (
    <main>
      <h1>RTSP Viewer</h1>
      <p className="subtitle">
        Next.js App Router · server component page · client player
      </p>
      <PlayerPanel />
    </main>
  );
}
