/**
 * server.ts — NestJS equivalent of the plain-http example.
 *
 *   POST /api/stream  { "rtspUrl": "rtsp://user:pass@cam/stream1" }
 *     -> { "path": "/stream/<token>" }
 *
 * Serves the same browser client as the other examples (../public).
 *
 * The WebSocket upgrade is handled by streamRTSP() on the underlying
 * http.Server. Nest (on the Express platform) creates and owns that
 * server; we grab it with app.getHttpServer() during bootstrap and hand
 * it to streamRTSP — Nest keeps ownership of the ordinary HTTP routes.
 *
 * Note: this example is run with tsx/esbuild, which does not emit
 * decorator *metadata* (design:paramtypes). We therefore avoid
 * constructor-based dependency injection and share the http.Server via a
 * module-scoped reference set in bootstrap().
 *
 * Run:
 *   npm run examples:nest
 * Then open http://localhost:8080
 */

import "reflect-metadata";
import * as path from "node:path";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import {
  BadRequestException,
  Body,
  Controller,
  Module,
  Post,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { streamRTSP, serveRtspPlayer } from "../../dist";

const HTTP_PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

let httpServer: Server; // set in bootstrap(), used by the controller

@Controller("api")
class StreamController {
  @Post("stream")
  create(@Body() body: { rtspUrl?: string }): { path: string } {
    const rtspUrl = body?.rtspUrl;
    if (!rtspUrl || !/^rtsp:\/\//i.test(rtspUrl)) {
      throw new BadRequestException("rtspUrl (rtsp://…) is required");
    }
    try {
      const wsPath = streamRTSP(httpServer, rtspUrl);
      console.log(`[api] ${rtspUrl.replace(/\/\/.*@/, "//***@")} -> ${wsPath}`);
      return { path: wsPath };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}

@Module({ controllers: [StreamController] })
class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error", "warn"],
  });
  httpServer = app.getHttpServer() as Server;
  // Serve /rtsp-player.js from the package's dist/html (no copy step).
  app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!serveRtspPlayer(req, res)) next();
  });
  app.useStaticAssets(PUBLIC_DIR); // serves index.html at "/"
  await app.listen(HTTP_PORT);
  console.log(`[nest] open http://localhost:${HTTP_PORT}`);
}

void bootstrap();
