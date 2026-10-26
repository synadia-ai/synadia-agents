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
      agentTools: 'blocking',
      turnStartGraceMs: 300_000,
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
      connectionLabel: 'context production from NATS_CONTEXT, NATS_URL unused',
      senderIdentity: 'signed',
      minSenderTrust: 'signed',
      permissionMode: 'terminal',
      agentTools: 'blocking',
      turnStartGraceMs: 300_000,
    })
  })

  test('NATS_CREDS connects with NATS_URL and a credentials file, no context needed', () => {
    expect(resolveRuntimeSettings({}, {
      NATS_URL: 'tls://connect.example:4222',
      NATS_CREDS: '/run/secrets/agent.creds',
    })).toMatchObject({
      connectionSource: { url: 'tls://connect.example:4222', creds: '/run/secrets/agent.creds' },
      connectionLabel: '$NATS_URL',
    })
  })

  test('NATS_CREDENTIALS is NATS_CREDS\'s alias, NATS_CREDS winning, empty meaning unset', () => {
    expect(resolveRuntimeSettings({}, { NATS_URL: 'nats://a:4222', NATS_CREDENTIALS: '/b.creds' }).connectionSource)
      .toEqual({ url: 'nats://a:4222', creds: '/b.creds' })
    expect(resolveRuntimeSettings({}, { NATS_URL: 'nats://a:4222', NATS_CREDS: '/c.creds', NATS_CREDENTIALS: '/b.creds' }).connectionSource)
      .toEqual({ url: 'nats://a:4222', creds: '/c.creds' })
    expect(resolveRuntimeSettings({}, { NATS_URL: 'nats://a:4222', NATS_CREDS: '' }).connectionSource)
      .toEqual({ url: 'nats://a:4222' })
  })

  test('credentials without NATS_URL fail rather than go to the public default', () => {
    expect(() => resolveRuntimeSettings({}, { NATS_CREDS: '/c.creds' })).toThrow(/without NATS_URL/)
    expect(() => resolveRuntimeSettings({}, { NATS_CREDENTIALS: '/c.creds', NATS_URL: '' })).toThrow(/without NATS_URL/)
  })

  test('the credentials-without-URL error starts with "invalid ", so the startup line on stderr shows it', () => {
    // server.ts's startupDescription passes a message through only when it starts with "invalid ".
    expect(() => resolveRuntimeSettings({ context: 'configured' }, { NATS_CREDS: '/c.creds' })).toThrow(
      /^invalid NATS_CREDS\/NATS_CREDENTIALS: set without NATS_URL; set NATS_URL to the server the credentials are for$/,
    )
  })

  test('a context wins over NATS_URL and NATS_CREDS', () => {
    expect(resolveRuntimeSettings({}, { NATS_CONTEXT: 'prod', NATS_URL: 'nats://a:4222', NATS_CREDS: '/c.creds' }).connectionSource)
      .toEqual({ context: 'prod' })
    // The config file's context is not read when the environment names a server.
    expect(() => resolveRuntimeSettings({ context: 'configured' }, { NATS_CREDS: '/c.creds' })).toThrow(/without NATS_URL/)
  })

  test('NATS_URL and credentials in the environment beat the config file\'s context', () => {
    expect(resolveRuntimeSettings(
      { context: 'configured' },
      { NATS_URL: 'tls://connect.example:4222', NATS_CREDS: '/run/secrets/agent.creds' },
    )).toMatchObject({
      connectionSource: { url: 'tls://connect.example:4222', creds: '/run/secrets/agent.creds' },
      connectionLabel: '$NATS_URL',
    })
    expect(resolveRuntimeSettings({ context: 'configured' }, { NATS_URL: 'nats://a:4222', NATS_CREDENTIALS: '/b.creds' }).connectionSource)
      .toEqual({ url: 'nats://a:4222', creds: '/b.creds' })
  })

  test('NATS_URL alone beats the config file\'s context', () => {
    expect(resolveRuntimeSettings({ context: 'configured' }, { NATS_URL: 'nats://localhost:4223' })).toMatchObject({
      connectionSource: { url: 'nats://localhost:4223' },
      connectionLabel: '$NATS_URL',
    })
  })

  test('the config file\'s context counts when the environment names no server, and the label names the file', () => {
    expect(resolveRuntimeSettings({ context: 'configured' }, {})).toMatchObject({
      connectionSource: { context: 'configured' },
      connectionLabel: 'context configured from config.json',
    })
    expect(resolveRuntimeSettings({ context: 'configured' }, {}, '~/.claude/channels/nats/config.json')).toMatchObject({
      connectionSource: { context: 'configured' },
      connectionLabel: 'context configured from ~/.claude/channels/nats/config.json',
    })
    // Empty variables are unset.
    expect(resolveRuntimeSettings(
      { context: 'configured' },
      { NATS_URL: '', NATS_CREDS: '', NATS_CREDENTIALS: '' },
      '/srv/nats-state/config.json',
    )).toMatchObject({
      connectionSource: { context: 'configured' },
      connectionLabel: 'context configured from /srv/nats-state/config.json',
    })
  })

  test('NATS_CONTEXT wins over the config file\'s context and names itself', () => {
    expect(resolveRuntimeSettings({ context: 'configured' }, { NATS_CONTEXT: 'prod' }, '/x/config.json')).toMatchObject({
      connectionSource: { context: 'prod' },
      connectionLabel: 'context prod from NATS_CONTEXT',
    })
    expect(resolveRuntimeSettings({}, { NATS_CONTEXT: 'prod', NATS_CREDS: '/c.creds' })).toMatchObject({
      connectionSource: { context: 'prod' },
      connectionLabel: 'context prod from NATS_CONTEXT, NATS_URL unused',
    })
  })

  test('an empty NATS_CONTEXT selects no context, not even the config file\'s', () => {
    expect(resolveRuntimeSettings({ context: 'configured' }, { NATS_CONTEXT: '' })).toMatchObject({
      connectionSource: { url: 'demo.nats.io' },
      connectionLabel: 'default: demo.nats.io',
    })
    expect(resolveRuntimeSettings({ context: 'configured' }, { NATS_CONTEXT: '', NATS_URL: 'nats://localhost:4222' })).toMatchObject({
      connectionSource: { url: 'nats://localhost:4222' },
      connectionLabel: '$NATS_URL',
    })
    expect(() => resolveRuntimeSettings({ context: 'configured' }, { NATS_CONTEXT: '', NATS_CREDS: '/c.creds' }))
      .toThrow(/without NATS_URL/)
  })

  test('an empty NATS_URL is unset: the default server, not the URL ""', () => {
    expect(resolveRuntimeSettings({}, { NATS_URL: '' })).toMatchObject({
      connectionSource: { url: 'demo.nats.io' },
      connectionLabel: 'default: demo.nats.io',
    })
  })

  test('agentTools: blocking by default, the config field, NATS_AGENT_TOOLS winning, empty meaning the default', () => {
    expect(resolveRuntimeSettings({}, {}).agentTools).toBe('blocking')
    expect(resolveRuntimeSettings({ agentTools: 'all' }, {}).agentTools).toBe('all')
    expect(resolveRuntimeSettings({ agentTools: 'all' }, { NATS_AGENT_TOOLS: 'off' }).agentTools).toBe('off')
    expect(resolveRuntimeSettings({ agentTools: 'all' }, { NATS_AGENT_TOOLS: '' }).agentTools).toBe('blocking')
    expect(() => resolveRuntimeSettings({}, { NATS_AGENT_TOOLS: 'some' })).toThrow(
      'invalid agentTools',
    )
  })

  test('turnStartGraceMs: five minutes by default, the config field, the variable winning, empty meaning the default', () => {
    const env = 'SYNADIA_CLAUDE_CODE_TURN_START_GRACE_MS'
    expect(resolveRuntimeSettings({}, {}).turnStartGraceMs).toBe(300_000)
    expect(resolveRuntimeSettings({ turnStartGraceMs: 60_000 }, {}).turnStartGraceMs).toBe(60_000)
    expect(resolveRuntimeSettings({ turnStartGraceMs: 60_000 }, { [env]: '2000' }).turnStartGraceMs).toBe(2000)
    expect(resolveRuntimeSettings({ turnStartGraceMs: 60_000 }, { [env]: '' }).turnStartGraceMs).toBe(60_000)
    for (const bad of ['0', '-5', '1.5', 'soon']) {
      expect(() => resolveRuntimeSettings({}, { [env]: bad })).toThrow('invalid turnStartGraceMs')
    }
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

  test('config.json keeps agentTools, extensions and unknown keys as read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-channel-config-'))
    try {
      const path = join(dir, 'config.json')
      const written = {
        agentTools: 'all',
        extensions: ['some-extension', { module: '/opt/ext', options: { level: 2 } }],
        somethingElse: true,
      }
      writeFileSync(path, JSON.stringify(written))
      expect(loadConfig(path)).toEqual(written)

      writeFileSync(path, JSON.stringify({ agentTools: 3 }))
      expect(() => loadConfig(path)).toThrow('invalid agentTools')

      writeFileSync(path, JSON.stringify({ turnStartGraceMs: '5m' }))
      expect(() => loadConfig(path)).toThrow('invalid turnStartGraceMs')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
