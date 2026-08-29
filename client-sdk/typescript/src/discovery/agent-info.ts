// `AgentInfo` — the pure-data view of an agent assembled from a
// `$SRV.INFO` record per spec §4.3. The `Agent` class wraps this with the
// `NatsConnection` needed to prompt it.

import { buildEndpointInfo, PROMPT_ENDPOINT_NAME, type EndpointInfo } from "./endpoint-info.js";
import { newAgentId, type AgentId } from "../identity/agent-id.js";
import { IDENTITY_METADATA_KEYS, verifyAgentId } from "../identity/id-sig.js";
import { isAgentServiceName } from "../internal/service-name.js";

export interface AgentInfo {
  /** Service id — unique per running instance (matches `heartbeat.instance_id`). */
  readonly instanceId: string;
  /** `metadata.agent`. */
  readonly agent: string;
  /** `metadata.owner`. */
  readonly owner: string;
  /** `metadata.session` when present. */
  readonly session?: string;
  /** 4th token of the prompt endpoint's subject. */
  readonly name: string;
  /** `metadata.protocol_version` (verbatim — MAJOR.MINOR comparison lives in `version.ts`). */
  readonly protocolVersion: string;
  /** Service-level `description`. */
  readonly description: string;
  /** Harness semver from the service `version` field. */
  readonly version: string;
  /** Full service metadata — unknown keys preserved per §5.6 and §12. */
  readonly metadata: Readonly<Record<string, string>>;
  /** All endpoints the agent registered. */
  readonly endpoints: ReadonlyArray<EndpointInfo>;
  /** Convenience — the `prompt` endpoint (guaranteed present on valid records). */
  readonly promptEndpoint: EndpointInfo;
  /**
   * `true` iff the prompt endpoint metadata carries `min_sender_trust` —
   * the feature-detection rule of the sender-identity extension. A 0.3
   * agent that never heard of identity reports `false`.
   */
  readonly supportsSenderIdentity: boolean;
  /**
   * The agent ID the instance registered (`user_nkey` + `account`
   * metadata), when both are present and well-formed. A registration
   * claim until {@link idSigVerified} says otherwise.
   */
  readonly identity?: AgentId;
  /**
   * `true` iff `id_sig` is present and verifies over the instance's own
   * `prompt` endpoint subject (`AGENT-ID-V1`). Computed only when
   * `id_sig` is present; one ed25519 verification per record.
   */
  readonly idSigVerified: boolean;
}

/** The shape of a `ServiceInfo` record as returned by `@nats-io/services`. */
export interface RawServiceInfo {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly metadata?: Record<string, string>;
  readonly endpoints: ReadonlyArray<{
    readonly name: string;
    readonly subject: string;
    readonly queue_group?: string;
    readonly metadata?: Record<string, string>;
  }>;
}

/**
 * Attempt to convert a raw `ServiceInfo` record into an {@link AgentInfo}.
 *
 * Returns `null` when the record is not a protocol-compliant agent — callers
 * silently drop these rather than erroring so unrelated micro-services
 * sharing the NATS account don't pollute discovery results.
 *
 * Returns `null` when any of the following holds:
 *   - The service `name` is not `"agents"` (spec §3.1).
 *   - Any of `metadata.agent`, `metadata.owner`, `metadata.protocol_version` is missing.
 *   - No endpoint named `prompt` is declared.
 */
export function buildAgentInfo(info: RawServiceInfo): AgentInfo | null {
  if (!isAgentServiceName(info.name)) return null;

  const metadata = info.metadata ?? {};
  const agent = metadata["agent"];
  const owner = metadata["owner"];
  const protocolVersion = metadata["protocol_version"];
  if (agent === undefined || owner === undefined || protocolVersion === undefined) {
    return null;
  }

  const endpoints = info.endpoints.map((e) => buildEndpointInfo(e));
  const promptEndpoint = endpoints.find((e) => e.name === PROMPT_ENDPOINT_NAME);
  if (!promptEndpoint) return null;

  // Per §4.3 step 3 (v0.3): derive instance name from the 5th token of the
  // prompt endpoint subject (`agents.prompt.<agent>.<owner>.<name>`) when it
  // follows the default verb-first pattern. Otherwise fall back to an empty
  // string — the caller can still address the agent via `promptEndpoint.subject`.
  const tokens = promptEndpoint.subject.split(".");
  const nameFromSubject = tokens[4];
  const name = nameFromSubject !== undefined && nameFromSubject !== "" ? nameFromSubject : "";

  const rawSession = metadata["session"];
  const session = rawSession !== undefined && rawSession !== "" ? rawSession : undefined;

  const identity = registeredIdentity(metadata);
  const idSigVerified =
    metadata[IDENTITY_METADATA_KEYS.idSig] !== undefined &&
    verifyAgentId(metadata, promptEndpoint.subject);

  return Object.freeze({
    instanceId: info.id,
    agent,
    owner,
    name,
    protocolVersion,
    description: info.description,
    version: info.version,
    metadata: Object.freeze({ ...metadata }),
    endpoints: Object.freeze(endpoints),
    promptEndpoint,
    supportsSenderIdentity: promptEndpoint.minSenderTrust !== undefined,
    idSigVerified,
    ...(identity !== undefined ? { identity } : {}),
    ...(session !== undefined ? { session } : {}),
  });
}

function registeredIdentity(metadata: Record<string, string>): AgentId | undefined {
  const user = metadata[IDENTITY_METADATA_KEYS.userNkey];
  const account = metadata[IDENTITY_METADATA_KEYS.account];
  if (user === undefined || account === undefined) return undefined;
  try {
    return newAgentId(account, user);
  } catch {
    return undefined;
  }
}
