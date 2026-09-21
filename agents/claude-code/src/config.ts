import { readFileSync } from 'node:fs'
import type { NatsConnectionSource } from '@synadia-ai/agents'

export type PermissionMode = 'terminal' | 'query'
export type SenderIdentityMode = 'off' | 'signed'
export type MinSenderTrust = 'any' | 'signed'

export type NatsChannelConfig = {
  context?: string
  owner?: string
  sessionName?: string
  senderIdentity?: SenderIdentityMode
  minSenderTrust?: MinSenderTrust
  permissions?: {
    // 'nats' is accepted as a backward-compatible alias for 'query'.
    mode: PermissionMode | 'nats'
    subject?: string
  }
}

export type RuntimeSettings = {
  connectionSource: NatsConnectionSource
  connectionLabel: string
  senderIdentity: SenderIdentityMode
  minSenderTrust: MinSenderTrust
  permissionMode: PermissionMode
}

export function loadConfig(path: string): NatsChannelConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrno(error) && error.code === 'ENOENT') return {}
    throw new Error('invalid config.json: cannot read file')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('invalid config.json: expected valid JSON')
  }
  if (!isRecord(parsed)) throw new Error('invalid config.json: expected an object')

  optionalString(parsed, 'context')
  optionalString(parsed, 'owner')
  optionalString(parsed, 'sessionName')
  optionalString(parsed, 'senderIdentity')
  optionalString(parsed, 'minSenderTrust')
  if (parsed.permissions !== undefined) {
    if (!isRecord(parsed.permissions)) {
      throw new Error('invalid permissions: expected an object')
    }
    optionalString(parsed.permissions, 'mode', true)
  }
  return parsed as NatsChannelConfig
}

/** Resolve configuration without reading any NATS context or credential file. */
export function resolveRuntimeSettings(
  config: NatsChannelConfig,
  env: NodeJS.ProcessEnv,
): RuntimeSettings {
  const context = env.NATS_CONTEXT ?? config.context
  const url = env.NATS_URL
  const senderIdentity = enumSetting(
    'senderIdentity',
    env.NATS_SENDER_IDENTITY ?? config.senderIdentity ?? 'off',
    ['off', 'signed'],
  )
  const minSenderTrust = enumSetting(
    'minSenderTrust',
    env.NATS_MIN_SENDER_TRUST ?? config.minSenderTrust ?? 'any',
    ['any', 'signed'],
  )
  const configuredPermission = config.permissions?.mode ?? 'terminal'
  const permissionMode = configuredPermission === 'nats'
    ? 'query'
    : enumSetting('permissions.mode', configuredPermission, ['terminal', 'query'])

  return {
    connectionSource: context
      ? { context }
      : { url: url ?? 'demo.nats.io' },
    connectionLabel: context
      ? `context: ${context}`
      : url
        ? '$NATS_URL'
        : 'default: demo.nats.io',
    senderIdentity,
    minSenderTrust,
    permissionMode,
  }
}

function enumSetting<const T extends string>(
  field: string,
  value: string,
  allowed: readonly T[],
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(
    `invalid ${field}: expected ${allowed.map(v => JSON.stringify(v)).join(' or ')}`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
  required = false,
): void {
  const candidate = value[field]
  if (candidate === undefined && !required) return
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`invalid ${field}: expected a non-empty string`)
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
