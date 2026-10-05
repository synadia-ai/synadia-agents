#!/usr/bin/env bun
/**
 * The plugin's Claude Code hook. Three events, one script:
 *
 * - SessionStart: record the session id Claude Code is now using, so the
 *   channel's MCP server, which keeps running across `/clear`, knows the
 *   session a prompt is delivered to.
 * - Stop: record that a turn ended, so the server knows when Claude Code
 *   is done, not only when the reply tool was called — the turn's closing
 *   model call comes after that — and whether background work could start
 *   another turn by itself. When a served prompt that owns the turn is
 *   still open, the hook first refuses the stop, once: it prints
 *   `{"decision":"block","reason":…}` naming the request and telling the
 *   model to send its answer with the reply tool, and records nothing. At
 *   the stop that follows (`stop_hook_active`) it never refuses, and it
 *   records the turn's final text, which the server sends as the reply
 *   when the model still did not.
 * - PreToolUse, every tool call: record the turn the call belongs to (its
 *   prompt id, and when the turn's first call was made), so the server can
 *   tell which served prompt a permission question comes from. For the
 *   agent tools also record the model's id for the call, which an MCP call
 *   does not carry, so the server can hand it to the agent tools. Claude
 *   Code runs the hook to completion before it sends the call or asks for
 *   permission.
 *
 * Reads the hook input from stdin, writes under `<state dir>/sessions/`
 * keyed by `CLAUDE_PID` (atomically, through a rename; see
 * `src/session-id.ts`), and exits 0 whatever happens — a hook must never
 * interrupt a session, and anything printed to stdout could land in the
 * model's context, so stdout stays empty except for a refused stop. It
 * fails open: whatever it cannot tell in time, it lets the turn end. It
 * writes whether or not an extension is loaded. It depends on nothing
 * outside the plugin directory, so it runs from source with `bun`.
 */

import { writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { recordHookEvent, stopRefusal } from '../src/session-id.js'

/** Well inside the hook's timeout in `hooks.json`: past it, exit without a word. */
const DEADLINE_MS = 5_000
setTimeout(() => process.exit(0), DEADLINE_MS).unref()

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
      const record = input as Record<string, unknown>
      const refusal = stopRefusal(stateDir, pid, record)
      if (refusal !== undefined) {
        // A refused stop is no stop: nothing is recorded, the turn goes on.
        // Synchronously: the process exits right after.
        writeSync(1, `${JSON.stringify({ decision: 'block', reason: refusal })}\n`)
      } else {
        recordHookEvent(stateDir, pid, record)
      }
    }
  }
} catch {
  // Best effort: the server falls back to its environment, and a tool call
  // without a recorded id runs without one.
}
process.exit(0)
