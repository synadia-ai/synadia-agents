import { readFileSync } from 'node:fs'
import type { NatsConnectionSource } from '@synadia-ai/agents'

export type PermissionMode = 'terminal' | 'query'
export type SenderIdentityMode = 'off' | 'signed'
export type MinSenderTrust = 'any' | 'signed'
export type AgentToolsMode = 'blocking' | 'all' | 'off'

/**
 * How long after a turn's Stop a served prompt that owned no turn may wait
 * for a turn to start before it is ended. Five minutes: a queued prompt's
 * turn starts at once after a Stop, and its first tool call, which is how
 * the plugin sees it, comes after the model's first reply, which takes
 * seconds to a minute or two. Well under the 30-minute request TTL, and
 * under the 10 to 15 minutes callers commonly wait.
 */
export const DEFAULT_TURN_START_GRACE_MS = 5 * 60 * 1000

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
  /** The agent tools offered to the model; `NATS_AGENT_TOOLS` wins. */
  agentTools?: AgentToolsMode
  /** Extension modules; read by `src/extensions.ts`, whose variables win. */
  extensions?: unknown
  /** See {@link DEFAULT_TURN_START_GRACE_MS}; `SYNADIA_CLAUDE_CODE_TURN_START_GRACE_MS` wins. */
  turnStartGraceMs?: number
}

export type RuntimeSettings = {
  connectionSource: NatsConnectionSource
  connectionLabel: string
  senderIdentity: SenderIdentityMode
  minSenderTrust: MinSenderTrust
  permissionMode: PermissionMode
  agentTools: AgentToolsMode
  turnStartGraceMs: number
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
  optionalString(parsed, 'agentTools')
  if (parsed.turnStartGraceMs !== undefined && !isPositiveWhole(parsed.turnStartGraceMs)) {
    throw new Error('invalid turnStartGraceMs: expected a whole number of milliseconds above 0')
  }
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
  // Unset or empty is the blocking three, as in the other plugins.
  const agentToolsValue = env.NATS_AGENT_TOOLS ?? config.agentTools
  const agentTools = agentToolsValue === undefined || agentToolsValue === ''
    ? 'blocking'
    : enumSetting('agentTools', agentToolsValue, ['blocking', 'all', 'off'])
  const graceValue = env.SYNADIA_CLAUDE_CODE_TURN_START_GRACE_MS
  const turnStartGraceMs = graceValue === undefined || graceValue === ''
    ? config.turnStartGraceMs ?? DEFAULT_TURN_START_GRACE_MS
    : Number(graceValue)
  if (!isPositiveWhole(turnStartGraceMs)) {
    throw new Error('invalid turnStartGraceMs: expected a whole number of milliseconds above 0')
  }

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
    agentTools,
    turnStartGraceMs,
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

function isPositiveWhole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
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
