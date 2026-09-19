// Status-token helpers. AgentService/PromptResponse performs the canonical
// wire encoding; this module only builds the application-specific status
// payloads consumed by the web UI.

import type { StatusChunk } from "@synadia-ai/agent-service";

/** Arbitrary status token (SDK callers tolerate unrecognized values). */
export function status(token: string): StatusChunk {
  return { type: "status", status: token };
}

export function toolUseStatus(
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): StatusChunk {
  const inputJson = JSON.stringify(input);
  let safeInput: Record<string, unknown> = input;
  if (inputJson.length > 4_000) {
    safeInput = {
      _truncated: true,
      _original_size_bytes: inputJson.length,
      _preview: inputJson.slice(0, 1_000) + "…[truncated]",
    };
  }
  return status(`tool_use:${JSON.stringify({ id: toolUseId, name, input: safeInput })}`);
}

export function toolResultStatus(
  toolUseId: string,
  output: string,
  isError: boolean,
): StatusChunk {
  const truncated = output.length > 4_000 ? output.slice(0, 4_000) + "…[truncated]" : output;
  return status(
    `tool_result:${JSON.stringify({ tool_use_id: toolUseId, output: truncated, is_error: isError })}`,
  );
}

export function costStatus(turnCostUsd: number, totalCostUsd: number): StatusChunk {
  return status(
    `cost:${JSON.stringify({ turn_cost_usd: turnCostUsd, total_cost_usd: totalCostUsd })}`,
  );
}
