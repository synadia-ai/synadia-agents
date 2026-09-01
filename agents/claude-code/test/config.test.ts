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
      permissionMode: 'terminal',
    })
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
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
