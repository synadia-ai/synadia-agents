import { createHash } from "node:crypto";
import { requireSubjectToken, sanitizeDerivedSubjectToken } from "../subject.js";
import type { OpenCodePluginContext, PluginIdentity } from "./types.js";

export function shortHash(input: unknown): string {
  return createHash("sha256").update(String(input ?? "")).digest("hex").slice(0, 12);
}

export function safePluginToken(input: string | undefined, fallback: string): string {
  return sanitizeDerivedSubjectToken(input ?? "") || fallback;
}

export function derivePluginIdentity(
  ctx: OpenCodePluginContext,
  env: Record<string, string | undefined> = process.env,
): PluginIdentity {
  const directoryHash = shortHash(ctx.directory ?? "");
  const worktreeHash = shortHash(ctx.worktree ?? "");
  const projectIdHash = shortHash(typeof ctx.project?.id === "string" ? ctx.project.id : "");
  const owner = requireSubjectToken(
    safePluginToken(env.SYNADIA_OPENCODE_OWNER ?? env.SYNADIA_OWNER ?? env.USER, "opencode"),
    "plugin.owner",
  );
  const explicitSession = env.SYNADIA_OPENCODE_SESSION ?? env.SYNADIA_SESSION;
  const fallbackSession = `session-${directoryHash}`;
  const session = requireSubjectToken(safePluginToken(explicitSession, fallbackSession), "plugin.session");
  const source = explicitSession ? "explicit" : "hashed-directory";
  const serverOrigin = safeServerOrigin(ctx.serverUrl);
  const metadata: Record<string, string> = {
    opencode_mode: "plugin",
    opencode_plugin: "true",
    opencode_identity_source: source,
    opencode_directory_hash: directoryHash,
    opencode_worktree_hash: worktreeHash,
    opencode_project_id_hash: projectIdHash,
  };
  if (serverOrigin) metadata.opencode_server_origin = serverOrigin;
  return { owner, session, source, directoryHash, worktreeHash, projectIdHash, serverOrigin, metadata };
}

export function safeServerOrigin(value: unknown): string {
  try {
    const url = value instanceof URL ? value : typeof value === "string" ? new URL(value) : undefined;
    return url?.origin ?? "";
  } catch {
    return "";
  }
}
