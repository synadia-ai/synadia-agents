// CLI + env parser. Flags beat env beats defaults.
//
//   bun run server/index.ts [--host 127.0.0.1] [--port 3300]
//                           [--context current] [--servers nats://...] [--dev]

export type ServerConfig = {
  host?: string;
  port: number;
  context?: string;
  servers?: string;
  dev: boolean;
};

export function parseConfig(argv: string[]): ServerConfig {
  // `Bun.argv` starts with ["bun", "server/index.ts", ...]; normalize to args only.
  const args = argv.slice(argv.findIndex((a) => a.endsWith("index.ts")) + 1);

  const pickFlag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return v;
  };
  const hasFlag = (name: string): boolean => args.includes(name);

  const host = pickFlag("--host") ?? process.env["AGENT_WEB_UI_HOST"];

  const portRaw = pickFlag("--port") ?? process.env["PORT"];
  const port = portRaw ? Number.parseInt(portRaw, 10) : 3300;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`--port must be 1..65535, got ${portRaw}`);
  }

  const contextFlag = pickFlag("--context");
  const serversFlag = pickFlag("--servers") ?? process.env["NATS_URL"];
  const dev = hasFlag("--dev");

  // If --servers is given, it wins outright. Otherwise fall back to context
  // (flag > env > default "current").
  const servers = serversFlag;
  const context = servers
    ? undefined
    : (contextFlag ?? process.env["NATS_CONTEXT"] ?? "current");

  return { host, port, context, servers, dev };
}
