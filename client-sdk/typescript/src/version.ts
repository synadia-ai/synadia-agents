// Protocol version comparison per spec §11.1.
//
// Only MAJOR.MINOR is significant for compatibility. Patch/pre-release
// qualifiers (e.g. `"0.1.0-draft"`) are parsed-and-discarded.

export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

const VERSION_PATTERN = /^\s*(\d+)\.(\d+)(?:[.-].*)?\s*$/;

/** The protocol version this SDK implements. */
export const SDK_PROTOCOL_VERSION: ProtocolVersion = Object.freeze({ major: 0, minor: 2 });

export class InvalidProtocolVersionError extends Error {
  constructor(public readonly input: string) {
    super(`invalid protocol version "${input}": expected MAJOR.MINOR`);
    this.name = "InvalidProtocolVersionError";
  }
}

export function parseProtocolVersion(input: string): ProtocolVersion {
  const match = VERSION_PATTERN.exec(input);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new InvalidProtocolVersionError(input);
  }
  return Object.freeze({ major: Number(match[1]), minor: Number(match[2]) });
}

export type VersionCompatibility =
  | "compatible" // Same MAJOR.MINOR — full interoperability.
  | "minor-drift" // Same MAJOR, different MINOR — proceed with caution.
  | "incompatible"; // Different MAJOR — no interoperability guarantee.

/**
 * Compare an agent's protocol version against the SDK's. Callers typically
 * refuse when the result is "incompatible" and warn on "minor-drift".
 */
export function compareProtocolVersion(
  agent: ProtocolVersion,
  sdk: ProtocolVersion = SDK_PROTOCOL_VERSION,
): VersionCompatibility {
  if (agent.major !== sdk.major) return "incompatible";
  if (agent.minor !== sdk.minor) return "minor-drift";
  return "compatible";
}
