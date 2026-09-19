import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { MsgHdrs, NatsConnection } from '@nats-io/transport-node'
import {
  AGENT_SENDER_HEADER,
  parseAgentId,
  parseSenderHeader,
  readSenderHeaderValue,
  signerFromSeed,
  traceRecordCounts,
  type AgentId,
  type Logger,
  type TraceScope,
} from '@synadia-ai/agents'
import {
  buildServedRecord,
  HARNESS,
  SERVED_RECORD_VERSION,
  ServedPublisher,
  unixSeconds,
} from '../src/served.js'

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>
}
const keys = JSON.parse(
  readFileSync(new URL('../../../test-fixtures/identity/keys.json', import.meta.url), 'utf8'),
) as KeysFile
const ALICE = keys.users['alice']!
const AGENT: AgentId = parseAgentId(`$G.${ALICE.public}`)
const SESSION = '317f624b-c7c6-4b27-936b-c0de80892e6d'
const THREAD = '0'.repeat(32)
const ROOT = 'f'.repeat(32)
const SUBJECT = 'TRACE.edges'

function decode(payload: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>
}

function scope(): TraceScope {
  return { threadId: THREAD, rootId: ROOT, turnCountHint: 0 }
}

function capturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: msg => warnings.push(msg),
      error: () => undefined,
    },
  }
}

type Published = { subject: string; payload: Uint8Array; headers: MsgHdrs }

function fakeConnection(): { nc: NatsConnection; published: Published[] } {
  const published: Published[] = []
  const nc = {
    publish: (subject: string, payload: Uint8Array, opts: { headers: MsgHdrs }) => {
      published.push({ subject, payload, headers: opts.headers })
    },
  } as unknown as NatsConnection
  return { nc, published }
}

describe('buildServedRecord', () => {
  test('writes the start record: the thread, the prefixed session, no status', () => {
    const before = unixSeconds()
    const { recordId, payload } = buildServedRecord(AGENT, THREAD, ROOT, SESSION, 'start')
    const { ts, ...rest } = decode(payload)
    expect(rest).toEqual({
      version: SERVED_RECORD_VERSION,
      kind: 'served',
      record_id: recordId,
      agent: AGENT,
      thread_id: THREAD,
      root_id: ROOT,
      harness: HARNESS,
      harness_thread_id: SESSION,
      phase: 'start',
    })
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(recordId).toMatch(/^[0-9a-f]{32}$/)
  })

  test('writes the end record with its status and the moment given as ts', () => {
    for (const status of ['ok', 'error', 'timeout'] as const) {
      const { payload } = buildServedRecord(AGENT, THREAD, ROOT, SESSION, 'end', status, 1_700_000_000)
      expect(decode(payload)).toMatchObject({ phase: 'end', status, ts: 1_700_000_000 })
    }
  })

  test('refuses an end record without a status, a start record with one, a bad ts or session', () => {
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, SESSION, 'end')).toThrow(/status/)
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, SESSION, 'start', 'ok')).toThrow(/status/)
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, SESSION, 'start', undefined, 1.5)).toThrow(/ts/)
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, 'has space', 'start')).toThrow(/session/)
  })
})

describe('ServedPublisher', () => {
  function publisher(overrides: Partial<ConstructorParameters<typeof ServedPublisher>[0]> = {}) {
    const { nc, published } = fakeConnection()
    const { logger, warnings } = capturingLogger()
    const served = new ServedPublisher({
      nc,
      subject: SUBJECT,
      signer: signerFromSeed(ALICE.seed),
      identity: () => AGENT,
      logger,
      ...overrides,
    })
    return { served, published, warnings }
  }

  test('publishes a signed pair in order: start on bind, end on settle', async () => {
    const { served, published, warnings } = publisher()
    const before = traceRecordCounts()
    const turn = served.beginTurn(scope())!
    turn.bind(SESSION)
    turn.settle('ok')
    await served.flush()

    expect(published.map(m => m.subject)).toEqual([SUBJECT, SUBJECT])
    const [start, end] = published.map(m => decode(m.payload))
    expect(start).toMatchObject({ kind: 'served', phase: 'start', harness_thread_id: SESSION })
    expect(end).toMatchObject({ kind: 'served', phase: 'end', status: 'ok', thread_id: THREAD, root_id: ROOT })
    expect(start!.record_id).not.toBe(end!.record_id)
    for (const m of published) {
      const record = decode(m.payload)
      const header = parseSenderHeader(readSenderHeaderValue(m.headers) ?? '')
      expect(header?.nonce).toBe(record.record_id as string)
      expect(`${header?.account}.${header?.user}`).toBe(AGENT)
      expect(header?.sub).toBe(SUBJECT)
      expect(m.headers.get('Nats-Msg-Id')).toBe(record.record_id as string)
      expect(m.headers.get(AGENT_SENDER_HEADER)).not.toBe('')
    }
    const after = traceRecordCounts()
    expect(after.published - before.published).toBe(2)
    expect(after.dropped - before.dropped).toBe(0)
    expect(warnings).toEqual([])
  })

  test('end takes the turn end it is given, else now', async () => {
    const { served, published } = publisher()
    const turn = served.beginTurn(scope())!
    turn.bind(SESSION)
    turn.settle('ok', 1_700_000_500)
    await served.flush()
    expect(decode(published[1]!.payload)).toMatchObject({ phase: 'end', ts: 1_700_000_500 })

    const later = publisher()
    const now = unixSeconds()
    const t2 = later.served.beginTurn(scope())!
    t2.bind(SESSION)
    t2.settle('ok')
    await later.served.flush()
    expect(decode(later.published[1]!.payload).ts as number).toBeGreaterThanOrEqual(now)
  })

  test('stamps start with the arrival, not the moment the session is bound', async () => {
    const { served, published } = publisher()
    const arrived = unixSeconds()
    const turn = served.beginTurn(scope())!
    turn.bind(SESSION)
    await served.flush()
    expect(decode(published[0]!.payload).ts).toBe(arrived)
  })

  test('an unusable session id is refused and nothing is published for the prompt', async () => {
    const { served, published, warnings } = publisher()
    const turn = served.beginTurn(scope())!
    turn.bind(undefined)
    turn.settle('ok')
    await served.flush()
    expect(published).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/no usable Claude Code session id/)
  })

  test('the session is bound once, and never after the turn ended', async () => {
    const { served, published, warnings } = publisher()
    const turn = served.beginTurn(scope())!
    turn.bind(SESSION)
    turn.bind('another-session')
    turn.settle('error')
    turn.settle('ok')
    turn.bind(SESSION)
    await served.flush()
    expect(published).toHaveLength(2)
    expect(decode(published[1]!.payload)).toMatchObject({ phase: 'end', status: 'error' })
    expect(warnings.map(w => w.split(';')[0])).toEqual([
      'served: session already bound for this prompt',
      'served: session bound after the turn ended',
    ])
  })

  test('a prompt outside a trace scope gets no pair', () => {
    const { served } = publisher()
    expect(served.beginTurn(undefined)).toBeUndefined()
  })

  test('without a signer nothing is published, the records count as dropped, one warning', async () => {
    const { served, published, warnings } = publisher({ signer: undefined })
    const before = traceRecordCounts()
    const turn = served.beginTurn(scope())!
    turn.bind(SESSION)
    turn.settle('timeout')
    await served.flush()
    expect(published).toEqual([])
    expect(traceRecordCounts().dropped - before.dropped).toBe(2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/senderIdentity/)
  })

  test('a publish that throws is counted as dropped and never fails the chain', async () => {
    let calls = 0
    const nc = {
      publish: () => {
        calls++
        if (calls === 1) throw new Error('connection closed')
      },
    } as unknown as NatsConnection
    const { served, warnings } = publisher({ nc })
    const before = traceRecordCounts()
    const turn = served.beginTurn(scope())!
    turn.bind(SESSION)
    turn.settle('ok')
    await served.flush()
    expect(calls).toBe(2)
    expect(traceRecordCounts().dropped - before.dropped).toBe(1)
    expect(traceRecordCounts().published - before.published).toBe(1)
    expect(warnings).toEqual(['served: failed to publish served record'])
  })
})
