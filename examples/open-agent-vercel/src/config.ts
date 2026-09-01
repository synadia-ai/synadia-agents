export type SenderIdentityMode = "off" | "signed";
export type MinSenderTrust = "any" | "signed";

export interface VercelNatsSettings {
  readonly natsContext?: string;
  readonly natsUrl?: string;
  readonly senderIdentity: SenderIdentityMode;
  readonly minSenderTrust: MinSenderTrust;
}

/** Parse `--nats-context value` and `--nats-context=value`. */
export function parseNatsContextFlag(
  argv: ReadonlyArray<string>,
): string | undefined {
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === "--nats-context") {
      const next = args[0];
      // Do not consume another flag as the context name.
      if (next !== undefined && !next.startsWith("--")) return args.shift();
      return undefined;
    }
    if (arg.startsWith("--nats-context=")) {
      const value = arg.slice("--nats-context=".length);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

function parseChoice<T extends string>(
  name: string,
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
): T {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `${name} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`,
  );
}

/** Resolve NATS target plus independent outgoing identity/inbound trust. */
export function resolveVercelNatsSettings(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): VercelNatsSettings {
  // Match the Open Agent CLI: explicit flag > NATS_CONTEXT > NATS_URL >
  // localhost inside connectFrom. A selected context always wins over URL.
  const natsContext = parseNatsContextFlag(argv) ?? env["NATS_CONTEXT"];
  const natsUrl = natsContext === undefined ? env["NATS_URL"] : undefined;
  return {
    ...(natsContext !== undefined && natsContext.length > 0
      ? { natsContext }
      : {}),
    ...(natsUrl !== undefined && natsUrl.length > 0 ? { natsUrl } : {}),
    senderIdentity: parseChoice(
      "NATS_SENDER_IDENTITY",
      env["NATS_SENDER_IDENTITY"],
      "off",
      ["off", "signed"],
    ),
    minSenderTrust: parseChoice(
      "NATS_MIN_SENDER_TRUST",
      env["NATS_MIN_SENDER_TRUST"],
      "any",
      ["any", "signed"],
    ),
  };
}
