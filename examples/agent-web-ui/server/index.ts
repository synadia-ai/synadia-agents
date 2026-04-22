// nats-ai-testui — Bun server entry point.
//
// Owns the single @synadia/agents Client (one NATS connection for the whole
// process) and serves:
//   - GET /ws     → WebSocket; each connection gets a fresh Bridge.
//   - everything else → static files from ./dist/ (SPA fallback to index.html).
//
// In --dev mode: no static serving; open the Vite dev server (port 5173)
// which proxies /ws back to us.

import { join, extname } from "node:path";
import { existsSync, statSync } from "node:fs";
import { connect, SDK_PROTOCOL_VERSION, type Client } from "@synadia/agents";
import { parseConfig } from "./config.ts";
import { Bridge, formatSdkProtocolVersion, type BridgeWsData } from "./bridge.ts";

const config = parseConfig(Bun.argv);

const client: Client = await connect(
  config.servers
    ? { name: "testui", servers: config.servers }
    : { name: "testui", context: config.context ?? "current" },
);

const serverInfoNote = config.servers
  ? `servers=${config.servers}`
  : `context=${config.context ?? "current"}`;
console.log(`[testui] NATS client connected (${serverInfoNote})`);

const distDir = join(import.meta.dir, "..", "dist");
const sdkVersionString = formatSdkProtocolVersion(SDK_PROTOCOL_VERSION);

const server = Bun.serve<BridgeWsData>({
  port: config.port,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const bridge = new Bridge(client, sdkVersionString);
      const upgraded = srv.upgrade(req, { data: { bridge } });
      if (upgraded) return undefined;
      return new Response("expected WebSocket upgrade on /ws", { status: 400 });
    }

    // Static file serving from dist/ when available.
    if (existsSync(distDir)) {
      const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = join(distDir, decodeURIComponent(safePath));
      // Reject path traversal outside dist/.
      if (!filePath.startsWith(distDir)) {
        return new Response("forbidden", { status: 403 });
      }
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return new Response(Bun.file(filePath));
      }
      // SPA fallback for extensionless routes.
      if (!extname(url.pathname)) {
        return new Response(Bun.file(join(distDir, "index.html")));
      }
      return new Response("not found", { status: 404 });
    }

    if (config.dev) {
      return new Response(
        "Dev mode: open http://localhost:5173 (run `bun run vite` in another terminal).\nThis port only serves /ws in dev.\n",
        { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    return new Response(
      "No dist/ found. Run `bun run build` to produce it, then `bun run start` again.\n",
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  },
  websocket: {
    open(ws) {
      ws.data.bridge.open(ws);
    },
    message(ws, msg) {
      const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
      ws.data.bridge.onMessage(text);
    },
    close(ws) {
      ws.data.bridge.close();
    },
  },
});

console.log(`[testui] listening on http://localhost:${server.port} (sdk protocol ${sdkVersionString})`);
if (config.dev) {
  console.log(`[testui] dev mode — open http://localhost:5173 (Vite)`);
} else if (!existsSync(distDir)) {
  console.log(`[testui] no dist/ found; run \`bun run build\` to serve the UI from this port`);
}

async function shutdown(sig: NodeJS.Signals): Promise<void> {
  console.log(`[testui] received ${sig}, shutting down...`);
  try {
    server.stop();
  } catch {
    /* noop */
  }
  try {
    await client.close();
  } catch (e) {
    console.warn("[testui] client.close() failed:", (e as Error).message);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
