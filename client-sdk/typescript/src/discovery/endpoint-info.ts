// Parsed endpoint metadata, derived from a `$SRV.INFO` record (§2.1, §4.3).

import { InvalidSizeError, parseHumanBytes } from "../bytes.js";

export interface EndpointInfo {
  readonly name: string;
  readonly subject: string;
  /**
   * Queue group the endpoint was registered with, as reported by the micro
   * service framework. Empty string means no queue group. Spec §3.3 requires
   * `"agents"` on the `prompt` endpoint.
   */
  readonly queueGroup: string;
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * `max_payload` parsed to bytes. Present only on the prompt endpoint, and
   * only when the agent declared a valid value.
   */
  readonly maxPayloadBytes?: number;
  /**
   * `attachments_ok` parsed to boolean. Present only on the prompt endpoint,
   * and only when the agent declared a value.
   */
  readonly attachmentsOk?: boolean;
}

export interface RawEndpoint {
  readonly name: string;
  readonly subject: string;
  readonly queue_group?: string;
  readonly metadata?: Record<string, string>;
}

/** The endpoint name the protocol reserves for the prompt entry point (§12). */
export const PROMPT_ENDPOINT_NAME = "prompt";

/**
 * Convert a `ServiceInfo.endpoints[]` entry into an {@link EndpointInfo},
 * parsing `max_payload` and `attachments_ok` when the endpoint is `prompt`.
 *
 * Invalid `max_payload` values leave `maxPayloadBytes` undefined (the raw
 * string remains available via `metadata`).
 */
export function buildEndpointInfo(raw: RawEndpoint): EndpointInfo {
  const metadata: Readonly<Record<string, string>> = Object.freeze({ ...(raw.metadata ?? {}) });
  const queueGroup = raw.queue_group ?? "";

  if (raw.name !== PROMPT_ENDPOINT_NAME) {
    return Object.freeze({ name: raw.name, subject: raw.subject, queueGroup, metadata });
  }

  let maxPayloadBytes: number | undefined;
  const mp = metadata["max_payload"];
  if (mp !== undefined) {
    try {
      maxPayloadBytes = parseHumanBytes(mp);
    } catch (err) {
      if (!(err instanceof InvalidSizeError)) throw err;
      // Drop the parsed value; metadata preserves the raw string.
    }
  }

  let attachmentsOk: boolean | undefined;
  const ao = metadata["attachments_ok"];
  if (ao === "true") attachmentsOk = true;
  else if (ao === "false") attachmentsOk = false;

  return Object.freeze({
    name: raw.name,
    subject: raw.subject,
    queueGroup,
    metadata,
    ...(maxPayloadBytes !== undefined ? { maxPayloadBytes } : {}),
    ...(attachmentsOk !== undefined ? { attachmentsOk } : {}),
  });
}
