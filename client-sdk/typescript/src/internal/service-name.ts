// The NATS micro service name that identifies protocol-compliant agents,
// per spec §3.1.
//
// Also exports the required queue group for the `prompt` endpoint
// (spec §3.3) — the framework-default would differ between SDK
// implementations and break interoperability, so the value is fixed
// here and every agent-side registration MUST pass it explicitly.

/** Spec §3.1: the service `name` that gates discovery. */
export const SERVICE_NAME = "agents";

/** Spec §3.3: queue group the `prompt` endpoint MUST register with. */
export const PROMPT_QUEUE_GROUP = "agents";

/** v0.3 §-TBD: endpoint name for the request/response status endpoint. */
export const STATUS_ENDPOINT_NAME = "status";

/** v0.3 §-TBD: queue group for the `status` endpoint — same as `prompt`. */
export const STATUS_QUEUE_GROUP = "agents";

/** @returns true iff `name` identifies a protocol-compliant agent service. */
export function isAgentServiceName(name: string): boolean {
  return name === SERVICE_NAME;
}
