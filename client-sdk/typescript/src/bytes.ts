// Pure utilities: size-unit parsing and UTF-8 byte-length measurement.
//
// Spec §2.1 defines `max_payload` as "a positive integer followed by B, KB,
// MB, or GB" but is silent on base (1000 vs 1024) and case-sensitivity. We
// use base-1024 (matching `nats-server` config conventions) and parse units
// case-insensitively. Both choices are flagged for upstream clarification.

const SIZE_PATTERN = /^\s*(\d+)\s*(B|KB|MB|GB)\s*$/i;

const MULTIPLIERS: Readonly<Record<string, number>> = Object.freeze({
  B: 1,
  KB: 1024,
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
});

export class InvalidSizeError extends Error {
  constructor(
    public readonly input: string,
    reason: string,
  ) {
    super(`invalid size "${input}": ${reason}`);
    this.name = "InvalidSizeError";
  }
}

/**
 * Parse a human-readable byte size (e.g. `"1MB"`, `"512KB"`, `"4gb"`) into a
 * byte count. Throws {@link InvalidSizeError} on malformed input.
 */
export function parseHumanBytes(input: string): number {
  const match = SIZE_PATTERN.exec(input);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new InvalidSizeError(input, "expected e.g. '1MB', '512KB', '4GB'");
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidSizeError(input, "non-finite or negative");
  }
  const unit = match[2].toUpperCase();
  const multiplier = MULTIPLIERS[unit];
  if (multiplier === undefined) {
    throw new InvalidSizeError(input, `unknown unit "${unit}"`);
  }
  const bytes = value * multiplier;
  if (!Number.isSafeInteger(bytes)) {
    throw new InvalidSizeError(input, "overflows safe integer range");
  }
  return bytes;
}

// Largest unit first so a server-reported `8388608` formats back to `"8MB"`,
// not `"8192KB"`.
const FORMAT_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["GB", 1024 ** 3],
  ["MB", 1024 ** 2],
  ["KB", 1024],
];

/**
 * Format an integer byte count back into the §2.1 `\d+(B|KB|MB|GB)` grammar.
 *
 * Picks the largest unit that divides `bytes` evenly so a server-reported
 * `8 * 1024 * 1024` round-trips cleanly to `"8MB"`, not `"8192KB"`. Used by
 * {@link AgentService} (`./service.ts`) to format a clamped server-derived
 * limit back into the spec's metadata grammar.
 */
export function formatHumanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0 || !Number.isInteger(bytes)) {
    throw new InvalidSizeError(String(bytes), "byte count must be a non-negative integer");
  }
  for (const [unit, multiplier] of FORMAT_UNITS) {
    if (bytes >= multiplier && bytes % multiplier === 0) {
      return `${bytes / multiplier}${unit}`;
    }
  }
  return `${bytes}B`;
}

const TEXT_ENCODER = new TextEncoder();

/** UTF-8 byte length of a JavaScript string. */
export function utf8ByteLength(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}
