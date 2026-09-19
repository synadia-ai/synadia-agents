#!/usr/bin/env bun
/**
 * Claude Code hook for the channel's tracing. Two events, one script:
 *
 * - SessionStart: record the session id Claude Code is now using, so the
 *   channel's MCP server, which keeps running across `/clear`, files each
 *   prompt under the right session.
 * - Stop: record that a turn ended, so the server can close a prompt's
 *   served window when Claude Code is really done, not when the reply
 *   tool was called — the turn's closing model call comes after that.
 *
 * Reads the hook payload from stdin, writes under `<state dir>/sessions/`
 * keyed by `CLAUDE_PID` (atomically, through a rename), and exits 0
 * whatever happens — a hook must never interrupt a session, and anything
 * printed to stdout would land in the model's context. With tracing off
 * it writes nothing. It depends on nothing outside the plugin directory,
 * so it runs from source.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resolveRuntimeSettings } from '../src/config.js'
import {
  isClaudeSessionId,
  sessionFilePath,
  sessionsDir,
  stopFilePath,
} from '../src/session-id.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function writeAtomically(target: string, content: string): void {
  const staging = `${target}.${process.pid}.tmp`
  writeFileSync(staging, content)
  renameSync(staging, target)
}

try {
  const pid = process.env.CLAUDE_PID
  if (pid !== undefined && /^\d+$/.test(pid)) {
    const payload = JSON.parse(await readStdin()) as {
      hook_event_name?: unknown
      session_id?: unknown
    }
    const stateDir = process.env.NATS_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'nats')
    // Inert unless tracing is on, resolved as the server resolves it: the
    // files exist for the served records and for nothing else.
    const settings = resolveRuntimeSettings(loadConfig(join(stateDir, 'config.json')), process.env)
    if (settings.tracing !== 'on') process.exit(0)
    if (payload.hook_event_name === 'Stop') {
      mkdirSync(sessionsDir(stateDir), { recursive: true })
      writeAtomically(stopFilePath(stateDir, pid), `${Date.now()}\n`)
    } else if (isClaudeSessionId(payload.session_id)) {
      mkdirSync(sessionsDir(stateDir), { recursive: true })
      writeAtomically(sessionFilePath(stateDir, pid), `${payload.session_id}\n`)
    }
  }
} catch {
  // Best effort: the server falls back to its environment and to a timeout.
}
process.exit(0)
