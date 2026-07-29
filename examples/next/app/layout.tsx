import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "RTSP Viewer (Next.js)",
  description: "rtsp-streamer App Router example",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
