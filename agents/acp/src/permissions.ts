import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { AcpPermissionPolicy } from "./types.js";

export type AcpPermissionDecision = "approve" | "deny" | "cancel";

export type PermissionSink = (prompt: string) => Promise<AcpPermissionDecision> | AcpPermissionDecision;

/**
 * Human-readable §7 query prompt for an ACP `session/request_permission`.
 * ACP surfaces the tool call being authorized plus the selectable options;
 * we compress that into one line the caller can answer with approve/deny.
 */
export function permissionPromptText(params: RequestPermissionRequest): string {
  const title = params.toolCall?.title ?? params.toolCall?.toolCallId ?? "a tool call";
  const kind = params.toolCall?.kind;
  let details = "";
  const rawInput = params.toolCall?.rawInput;
  if (rawInput !== undefined) {
    try {
      details = JSON.stringify(rawInput).slice(0, 1200);
    } catch {
      /* non-serializable rawInput — omit */
    }
  }
  return `ACP agent requests permission: ${title}${kind ? ` [${kind}]` : ""}. ` +
    `Reply approve to allow once; anything else denies.${details ? ` Details: ${details}` : ""}`;
}

function findOption(options: readonly PermissionOption[], kinds: readonly string[]): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match;
  }
  return undefined;
}

/**
 * Map an approve/deny/cancel decision onto the agent-offered options.
 * approve -> allow_once (falling back to allow_always), deny -> reject_once
 * (falling back to reject_always). When the agent offered no matching option,
 * or on cancel, respond with the `cancelled` outcome — the spec's "user
 * dismissed" answer.
 */
export function selectPermissionOutcome(
  options: readonly PermissionOption[],
  decision: AcpPermissionDecision,
): RequestPermissionResponse {
  const chosen = decision === "approve"
    ? findOption(options, ["allow_once", "allow_always"])
    : decision === "deny"
      ? findOption(options, ["reject_once", "reject_always"])
      : undefined;
  if (chosen === undefined) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: chosen.optionId } };
}

/**
 * Resolve an inbound permission request per the adapter policy:
 * - `allow`  — approve every request (allow_once). Headless demos only.
 * - `query`  — relay to the caller as a §7 query chunk via `sink`; timeout
 *              or missing sink degrades to cancel.
 * - `reject` — deny without asking (the safe default).
 */
export async function resolvePermissionRequest(
  params: RequestPermissionRequest,
  opts: { readonly policy: AcpPermissionPolicy; readonly sink?: PermissionSink; readonly timeoutMs?: number },
): Promise<RequestPermissionResponse> {
  if (opts.policy === "allow") return selectPermissionOutcome(params.options, "approve");
  if (opts.policy === "query" && opts.sink) {
    const decision = await withTimeout(opts.sink(permissionPromptText(params)), opts.timeoutMs ?? 30_000);
    return selectPermissionOutcome(params.options, decision);
  }
  return selectPermissionOutcome(params.options, "deny");
}

async function withTimeout(
  value: Promise<AcpPermissionDecision> | AcpPermissionDecision,
  timeoutMs: number,
): Promise<AcpPermissionDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<"cancel">((resolve) => { timer = setTimeout(() => resolve("cancel"), timeoutMs); });
    return await Promise.race([Promise.resolve(value), timed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
