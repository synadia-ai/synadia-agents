// Pluggable logger interface. The SDK ships with a silent default — libraries
// should not emit to the console unconditionally. Consumers inject their own
// logger via `new Agents({ nc, logger })`.

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

export const SILENT_LOGGER: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
