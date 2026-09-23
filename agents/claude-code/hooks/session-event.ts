#!/usr/bin/env bun
/**
 * The plugin's Claude Code hook. Three events, one script:
 *
 * - SessionStart: record the session id Claude Code is now using, so the
 *   channel's MCP server, which keeps running across `/clear`, knows the
 *   session a prompt is delivered to.
 * - Stop: record that a turn ended, so the server knows when Claude Code
 *   is done, not only when the reply tool was called — the turn's closing
 *   model call comes after that.
 * - PreToolUse, for the agent tools only (the matcher in `hooks.json`):
 *   record the model's id for the tool call, which an MCP call does not
 *   carry, so the server can hand it to the agent tools. Claude Code runs
 *   the hook to completion before it sends the call.
 *
 * Reads the hook input from stdin, writes under `<state dir>/sessions/`
 * keyed by `CLAUDE_PID` (atomically, through a rename; see
 * `src/session-id.ts`), and exits 0 whatever happens — a hook must never
 * interrupt a session, and anything printed to stdout could land in the
 * model's context. It writes whether or not an extension is loaded. It
 * depends on nothing outside the plugin directory, so it runs from source
 * with `bun`.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { recordHookEvent } from '../src/session-id.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

try {
  const pid = process.env.CLAUDE_PID
  if (pid !== undefined && /^\d+$/.test(pid)) {
    const input = JSON.parse(await readStdin()) as unknown
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      const stateDir = process.env.NATS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'nats')
      recordHookEvent(stateDir, pid, input as Record<string, unknown>)
    }
  }
} catch {
  // Best effort: the server falls back to its environment, and a tool call
  // without a recorded id runs without one.
}
process.exit(0)
