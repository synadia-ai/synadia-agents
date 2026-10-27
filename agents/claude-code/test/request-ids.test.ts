// The ids a server gives its requests: unique per server start, so a
// channel message an earlier server sent never names one of this server's
// requests; usable wherever the hooks' files keep a request id; never a
// local turn's.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestIdSequence } from '../src/request-ids.js'
import { channelPrompt, readOpenFile, writeOpenRequests } from '../src/session-id.js'
import { LOCAL_TURN_PREFIX } from '../src/turns.js'

let stateDir: string
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'claude-channel-request-ids-'))
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('requestIdSequence', () => {
  test('an id is <instance>-<n>: 8 hex characters per sequence, then a count from 1', () => {
    const next = requestIdSequence()
    const [a, b, c] = [next(), next(), next()]
    expect(a).toMatch(/^[0-9a-f]{8}-1$/)
    const instance = a.slice(0, 8)
    expect([b, c]).toEqual([`${instance}-2`, `${instance}-3`])
  })

  test('two server starts give different first ids', () => {
    expect(requestIdSequence()()).not.toBe(requestIdSequence()())
  })

  test('an id is a request id to the hooks\' files: read from a channel tag, kept in the server\'s file', () => {
    const next = requestIdSequence()
    const ids = [next(), next()]
    for (const id of ids) {
      expect(channelPrompt(`<channel source="plugin:nats-channel:nats" request_id="${id}" session="s">hi`))
        .toEqual({ requestId: id, source: 'plugin:nats-channel:nats' })
    }
    writeOpenRequests(stateDir, 4242, [ids[0]!], process.pid, 1000, { openIds: ids })
    expect(readOpenFile(stateDir, 4242)).toEqual({ requestIds: [ids[0]!], openIds: ids })
  })

  test('an id never starts with a local turn\'s prefix', () => {
    for (let i = 0; i < 1000; i++) {
      expect(requestIdSequence()().startsWith(LOCAL_TURN_PREFIX)).toBe(false)
    }
  })
})
