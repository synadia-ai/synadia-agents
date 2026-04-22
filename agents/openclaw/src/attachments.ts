// On-disk staging for inline attachments (spec §5.1, §5.2).
//
// Each attachment is written to:
//
//   <baseDir>/<agentName>/<uuid>/<sanitized_filename>
//
// `<baseDir>` is supplied by the gateway — it must be a directory OpenClaw's
// media tools treat as allowed (see openclaw/src/media/local-roots.ts), which
// today means somewhere under `<stateDir>/media`. The `<agentName>` directory
// is removed on gateway shutdown; the per-request `<uuid>` subdir guarantees
// filenames can repeat across requests without colliding. Follow-up turns
// within the session can still reference earlier paths because we don't clean
// per-request.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DecodedAttachment } from "./nats/types.js";

/**
 * Write each attachment to disk under `<baseDir>/<agentName>/<uuid>/…` and
 * return an augmented prompt with the absolute paths listed up front.
 * Throws on I/O failure — callers map that to a spec §9 status 500.
 */
export function stageAttachmentsIntoPrompt(args: {
  baseDir: string;
  agentName: string;
  prompt: string;
  attachments: DecodedAttachment[];
}): string {
  if (args.attachments.length === 0) return args.prompt;
  const reqDir = join(args.baseDir, args.agentName, randomUUID());
  mkdirSync(reqDir, { recursive: true });
  const paths: string[] = [];
  for (const a of args.attachments) {
    const target = join(reqDir, a.filename);
    writeFileSync(target, a.bytes);
    paths.push(target);
  }
  const list = paths.map((p) => `- ${p}`).join("\n");
  return `[Attachments available at the following absolute paths]\n${list}\n\n${args.prompt}`;
}

/** Recursively remove the agent's staging dir. Best-effort; never throws. */
export function cleanupAgentStaging(baseDir: string, agentName: string): void {
  try {
    rmSync(join(baseDir, agentName), { recursive: true, force: true });
  } catch {
    // best effort — usually tearing down already
  }
}
