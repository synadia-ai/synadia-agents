// Whether Claude Code takes the prompts the channel hands it: the bound on
// idle time, on a clock the tests pass in, and which clients it applies to.

import { describe, expect, test } from 'bun:test'
import {
  CHANNEL_OFF_CODE,
  ChannelCheck,
  DEFAULT_IDLE_TURN_START_MS,
  MAX_ERROR_DESCRIPTION,
  channelCheckable,
  channelOffDescription,
  channelOffWarning,
  formatBound,
} from '../src/channel-check.js'

const BOUND = 30_000
const idle = (sinceMs?: number) => ({ busy: false as const, ...(sinceMs !== undefined ? { sinceMs } : {}) })
const busy = { busy: true as const }

describe('ChannelCheck: a prompt delivered while idle', () => {
  test('is due once the bound has passed since its delivery, not before, and only once', () => {
    const check = new ChannelCheck(BOUND)
    check.delivered('r-1', 1_000)
    expect(check.due(1_000 + BOUND - 1, idle())).toEqual([])
    expect(check.due(1_000 + BOUND, idle())).toEqual(['r-1'])
    expect(check.due(1_000 + BOUND + 5_000, idle())).toEqual([])
  })

  test('a turn that ended before the delivery does not shorten its bound', () => {
    const check = new ChannelCheck(BOUND)
    check.delivered('r-1', 10_000)
    expect(check.due(10_000 + BOUND - 1, idle(2_000))).toEqual([])
    expect(check.due(10_000 + BOUND, idle(2_000))).toEqual(['r-1'])
  })

  test('each prompt has its own bound', () => {
    const check = new ChannelCheck(BOUND)
    check.delivered('r-1', 0)
    check.delivered('r-2', 10_000)
    expect(check.due(BOUND, idle())).toEqual(['r-1'])
    expect(check.due(10_000 + BOUND - 1, idle())).toEqual([])
    expect(check.due(10_000 + BOUND, idle())).toEqual(['r-2'])
  })
})

describe('ChannelCheck: a prompt queued behind a busy turn', () => {
  test('is never due while a turn runs, however long', () => {
    const check = new ChannelCheck(BOUND)
    check.delivered('r-1', 0)
    expect(check.due(BOUND, busy)).toEqual([])
    expect(check.due(10 * BOUND, busy)).toEqual([])
  })

  test('its bound runs from the end of that turn', () => {
    const check = new ChannelCheck(BOUND)
    check.delivered('r-1', 0)
    expect(check.due(120_000, busy)).toEqual([])
    // The turn stopped at 150 s: Claude Code would take the prompt now.
    expect(check.due(150_000 + BOUND - 1, idle(150_000))).toEqual([])
    expect(check.due(150_000 + BOUND, idle(150_000))).toEqual(['r-1'])
  })

  test('a turn that begins within the bound restarts it at its end', () => {
    const check = new ChannelCheck(BOUND)
    check.delivered('r-1', 0)
    expect(check.due(20_000, idle())).toEqual([])
    expect(check.due(40_000, busy)).toEqual([])
    expect(check.due(60_000, idle(55_000))).toEqual([])
    expect(check.due(55_000 + BOUND, idle(55_000))).toEqual(['r-1'])
  })
})

describe('ChannelCheck: once Claude Code took a channel message', () => {
  test('the prompts waiting are no longer due, and the channel is on', () => {
    const check = new ChannelCheck(BOUND)
    check.delivered('r-1', 0)
    check.delivered('r-2', 0)
    expect(check.on).toBe(false)
    check.taken()
    expect(check.on).toBe(true)
    expect(check.due(10 * BOUND, idle())).toEqual([])
  })

  test('a later prompt is never due: a dialog held open does not cut it', () => {
    const check = new ChannelCheck(BOUND)
    check.taken()
    check.delivered('r-3', 0)
    expect(check.due(10 * BOUND, idle())).toEqual([])
  })
})

describe('ChannelCheck: the rest', () => {
  test('a forgotten request is never due', () => {
    const check = new ChannelCheck(BOUND)
    check.delivered('r-1', 0)
    check.forget('r-1')
    expect(check.due(BOUND, idle())).toEqual([])
  })

  test('a bound of 0 turns the check off', () => {
    const check = new ChannelCheck(0)
    check.delivered('r-1', 0)
    expect(check.due(10 * BOUND, idle())).toEqual([])
  })

  test('firstOff is true once', () => {
    const check = new ChannelCheck(BOUND)
    expect(check.firstOff()).toBe(true)
    expect(check.firstOff()).toBe(false)
  })
})

describe('channelCheckable', () => {
  test('Claude Code from 2.1.310 on', () => {
    expect(channelCheckable({ name: 'claude-code', version: '2.1.310' })).toBe(true)
    expect(channelCheckable({ name: 'claude-code', version: '2.1.331' })).toBe(true)
    expect(channelCheckable({ name: 'claude-code', version: '2.2.0' })).toBe(true)
    expect(channelCheckable({ name: 'claude-code', version: '3.0.0' })).toBe(true)
    expect(channelCheckable({ name: 'claude-code', version: '2.1.400-beta.1' })).toBe(true)
  })

  test('an older Claude Code, another client, or no version: off', () => {
    expect(channelCheckable({ name: 'claude-code', version: '2.1.309' })).toBe(false)
    expect(channelCheckable({ name: 'claude-code', version: '2.0.999' })).toBe(false)
    expect(channelCheckable({ name: 'claude-code', version: '1.9.400' })).toBe(false)
    expect(channelCheckable({ name: 'claude-code', version: 'unknown' })).toBe(false)
    expect(channelCheckable({ name: 'claude-code' })).toBe(false)
    expect(channelCheckable({ name: 'fake-claude', version: '2.1.331' })).toBe(false)
    expect(channelCheckable(undefined)).toBe(false)
  })
})

describe('what the caller and the log are told', () => {
  test('the default bound is 30 s', () => {
    expect(DEFAULT_IDLE_TURN_START_MS).toBe(30_000)
    expect(formatBound(30_000)).toBe('30 s')
    expect(formatBound(1_500)).toBe('1500 ms')
  })

  test('the error is one line that names the bound and the likely causes, code 503, never cut by the SDK', () => {
    const text = channelOffDescription(30_000)
    expect(CHANNEL_OFF_CODE).toBe(503)
    expect(text).toBe(
      'Claude Code did not take this prompt within 30 s while idle: its channel is likely off. ' +
        'Check: its own ANTHROPIC_API_KEY, Yes to "Do you want to use this API key?", a workspace-scoped key',
    )
    for (const bound of [1, 1_500, 30_000, 86_400_000, 999_999_999]) {
      const description = channelOffDescription(bound)
      expect(description).not.toMatch(/[\r\n]/)
      expect(description.length).toBeLessThanOrEqual(MAX_ERROR_DESCRIPTION)
    }
  })

  test('the warning names the bound and every likely cause', () => {
    const text = channelOffWarning(1_500)
    expect(text).toStartWith('warning: Claude Code did not take a prompt within 1500 ms while idle; its channel is likely off')
    expect(text).not.toMatch(/[\r\n]/)
    for (const part of [
      '--channels or --dangerously-load-development-channels',
      'ANTHROPIC_API_KEY',
      '"Do you want to use this API key?" was answered Yes',
      "key's scope is a workspace, not the organization",
      '"Channels are not currently available"',
    ]) {
      expect(text).toContain(part)
    }
  })
})
