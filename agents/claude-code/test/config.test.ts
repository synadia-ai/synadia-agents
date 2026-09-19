import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resolveRuntimeSettings } from '../src/config.js'

describe('resolveRuntimeSettings', () => {
  test('identity and strict admission are off and permissive by default', () => {
    expect(resolveRuntimeSettings({}, {})).toEqual({
      connectionSource: { url: 'demo.nats.io' },
      connectionLabel: 'default: demo.nats.io',
      senderIdentity: 'off',
      minSenderTrust: 'any',
      tracing: 'off',
      permissionMode: 'terminal',
    })
  })

  test('tracing is off by default and independent of identity', () => {
    expect(resolveRuntimeSettings({ tracing: 'on' }, {})).toMatchObject({
      senderIdentity: 'off',
      tracing: 'on',
    })
    expect(resolveRuntimeSettings({ tracing: 'off' }, { NATS_TRACING: 'on' })).toMatchObject({
      tracing: 'on',
    })
    expect(resolveRuntimeSettings({ tracing: 'on' }, { NATS_TRACING: 'off' })).toMatchObject({
      tracing: 'off',
    })
    expect(() => resolveRuntimeSettings({}, { NATS_TRACING: 'yes' })).toThrow('invalid tracing')
  })

  test('keeps identity and inbound trust independent', () => {
    expect(resolveRuntimeSettings({ senderIdentity: 'signed' }, {})).toMatchObject({
      senderIdentity: 'signed',
      minSenderTrust: 'any',
    })
    expect(resolveRuntimeSettings({ minSenderTrust: 'signed' }, {})).toMatchObject({
      senderIdentity: 'off',
      minSenderTrust: 'signed',
    })
  })

  test('environment overrides config and a context wins over NATS_URL', () => {
    expect(resolveRuntimeSettings(
      {
        context: 'configured',
        senderIdentity: 'off',
        minSenderTrust: 'any',
      },
      {
        NATS_CONTEXT: 'production',
        NATS_URL: 'nats://ignored.example:4222',
        NATS_SENDER_IDENTITY: 'signed',
        NATS_MIN_SENDER_TRUST: 'signed',
      },
    )).toEqual({
      connectionSource: { context: 'production' },
      connectionLabel: 'context: production',
      senderIdentity: 'signed',
      minSenderTrust: 'signed',
      tracing: 'off',
      permissionMode: 'terminal',
    })
  })

  test('retains the legacy nats permission alias', () => {
    expect(resolveRuntimeSettings({ permissions: { mode: 'nats' } }, {})).toMatchObject({
      permissionMode: 'query',
    })
  })

  test('rejects invalid identity and trust values', () => {
    expect(() => resolveRuntimeSettings({}, { NATS_SENDER_IDENTITY: 'auto' })).toThrow(
      'invalid senderIdentity',
    )
    expect(() => resolveRuntimeSettings({}, { NATS_MIN_SENDER_TRUST: 'verified' })).toThrow(
      'invalid minSenderTrust',
    )
  })

  test('a malformed config never silently downgrades identity settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-channel-config-'))
    try {
      const path = join(dir, 'config.json')
      writeFileSync(path, '{"senderIdentity":"signed"')
      expect(() => loadConfig(path)).toThrow('invalid config.json')

      writeFileSync(path, JSON.stringify({ senderIdentity: 42 }))
      expect(() => loadConfig(path)).toThrow('invalid senderIdentity')

      writeFileSync(path, JSON.stringify({ tracing: true }))
      expect(() => loadConfig(path)).toThrow('invalid tracing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
