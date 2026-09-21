/** AgentService logger that never serializes arbitrary errors, headers, or credentials. */
export const protocolLogger = {
  debug(message: string, context?: Readonly<Record<string, unknown>>) {
    write("debug", message, context);
  },
  info(message: string, context?: Readonly<Record<string, unknown>>) {
    write("info", message, context);
  },
  warn(message: string, context?: Readonly<Record<string, unknown>>) {
    write("warn", message, context);
  },
  error(message: string, context?: Readonly<Record<string, unknown>>) {
    write("error", message, context);
  },
};

function write(
  level: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): void {
  const safe: Record<string, string | number> = {};
  for (const key of ["subject", "sender", "code", "maxPayload", "serverMaxPayload"]) {
    const value = context?.[key];
    if (typeof value === "string" || typeof value === "number") safe[key] = value;
  }
  process.stderr.write(
    `claude-code-headless: protocol ${level}: ${message} ${JSON.stringify(safe)}\n`,
  );
}
