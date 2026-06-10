import type { OpenCodePermissionReply } from "../permissions.js";
import { permissionIdsFromEvent, permissionQuestionFromEvent } from "../permissions.js";
import type { OpenCodePluginContext, PluginPermissionReply } from "./types.js";

export function isPluginPermissionEvent(event: unknown): boolean {
  if (!isRecord(event)) return false;
  const type = readString(event, "type") ?? readString(event, "event") ?? readString(event, "name");
  return type === "permission.asked" || type === "permission.v2.asked" || type === "permission.updated";
}

export function pluginPermissionQuestion(event: unknown): string {
  return permissionQuestionFromEvent(event);
}

export async function replyToPluginPermission(input: {
  readonly ctx: OpenCodePluginContext;
  readonly event: unknown;
  readonly reply: OpenCodePermissionReply;
}): Promise<void> {
  const ids = permissionIdsFromEvent(input.event);
  if (!ids) throw new Error("OpenCode permission event is missing session id or permission id");
  const reply = input.reply as PluginPermissionReply;
  const directory = input.ctx.directory;
  const pluginReply = input.ctx.client?.permission?.reply;
  if (pluginReply) {
    const result = await pluginReply({ requestID: ids.permissionId, reply, ...(directory ? { directory } : {}) });
    if (!isRecord(result) || !result.error) return;
  }
  const direct = await postDirectPermissionReply(input.ctx.serverUrl, ids.sessionId, ids.permissionId, reply, directory);
  if (direct === "ok") return;
  const sdkReply = input.ctx.client?.postSessionIdPermissionsPermissionId;
  if (sdkReply) {
    const result = await sdkReply({
      path: { id: ids.sessionId, permissionID: ids.permissionId },
      ...(directory ? { query: { directory } } : {}),
      body: { response: reply },
    });
    if (isRecord(result) && result.error) throw new Error(`OpenCode permission reply failed: ${JSON.stringify(result.error)}`);
    return;
  }
  throw new Error("OpenCode permission reply API is unavailable in plugin context");
}

async function postDirectPermissionReply(
  serverUrl: URL | string | undefined,
  sessionId: string,
  permissionId: string,
  reply: PluginPermissionReply,
  directory: string | undefined,
): Promise<"ok" | "unavailable"> {
  if (!serverUrl) return "unavailable";
  const origin = serverUrl instanceof URL ? serverUrl : new URL(serverUrl);
  const paths = [
    `/permission/${encodeURIComponent(permissionId)}/reply`,
    `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionId)}/reply`,
  ];
  for (const path of paths) {
    const url = new URL(path, origin);
    if (directory) url.searchParams.set("directory", directory);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply, response: reply }),
    }).catch(() => undefined);
    if (res?.ok) return "ok";
  }
  return "unavailable";
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
