// The session's description (src/description.ts): the cleaning rule against
// its vectors, and the precedence chain server.ts resolves it by,
// SYNADIA_CLAUDE_CODE_DESCRIPTION, then SYNADIA_DESCRIPTION, then the
// config file's `description`, then the default text.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESCRIPTION_LIMIT, cleanDescription, resolveDescription } from '../src/description.js'

type CleanVector = { name: string; in: string; out: string }
const vectors = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'description-clean-vectors.json'),
    'utf8',
  ),
) as { limit: number; clean: CleanVector[] }

const codePoints = (text: string): number => Array.from(text).length

describe('cleanDescription', () => {
  test('the limit is the vectors\' limit', () => {
    expect(DESCRIPTION_LIMIT).toBe(vectors.limit)
    expect(vectors.clean.length).toBeGreaterThan(0)
  })

  for (const vector of vectors.clean) {
    test(`vector: ${vector.name}`, () => {
      expect(cleanDescription(vector.in)).toBe(vector.out)
    })
  }

  test('cleaning a cleaned description changes nothing', () => {
    for (const vector of vectors.clean) {
      expect(cleanDescription(vector.out)).toBe(vector.out)
    }
  })

  test('length is counted in code points, and a cut never splits one', () => {
    const astral = '\u{1F44D}'
    const cleaned = cleanDescription(astral.repeat(DESCRIPTION_LIMIT + 5))
    expect(codePoints(cleaned)).toBe(DESCRIPTION_LIMIT)
    expect(cleaned).toBe(astral.repeat(DESCRIPTION_LIMIT))
  })

  test('the zero width non-joiner and joiner stay, and are no reason for a warning', () => {
    // Persian spells with U+200C; an emoji sequence is joined by U+200D.
    const persian = '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645'
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'
    const text = `${persian} ${family}`
    expect(cleanDescription(text)).toBe(text)
    expect(resolveDescription(text)).toEqual({ text })
    // Every other invisible format character still becomes a space.
    expect(cleanDescription('a\u200bb\u200ec\u2060d\ufeffe')).toBe('a b c d e')
  })

  test('one code point at a time: no space-like character hides behind the one before it', () => {
    // A global match over the whole string missed these on Bun 1.3.14,
    // whose engine paired a UTF-16 unit in U+F800..U+FBFF with the one
    // after it: a U+FEFF after the ligature U+FB01 stayed in place.
    expect(cleanDescription('of\ufb01\ufeffce')).toBe('of\ufb01 ce')
    expect(cleanDescription('a\uf900\ufff9b')).toBe('a\uf900 b')
    const missed: string[] = []
    for (let lead = 0xf800; lead <= 0xfbff; lead++) {
      const before = String.fromCharCode(lead)
      for (const hidden of ['\ufeff', '\ufff9', '\ufffa', '\ufffb']) {
        if (cleanDescription(`a${before}${hidden}b`) !== `a${before} b`) {
          missed.push(`U+${lead.toString(16)} U+${hidden.charCodeAt(0).toString(16)}`)
        }
      }
    }
    expect(missed).toEqual([])
  })
})

describe('resolveDescription', () => {
  test('the per-agent variable wins over the shared one and the config field', () => {
    expect(resolveDescription('per agent', 'shared', 'from config')).toEqual({ text: 'per agent' })
  })

  test('the shared variable wins over the config field', () => {
    expect(resolveDescription(undefined, 'shared', 'from config')).toEqual({ text: 'shared' })
  })

  test('the config field counts when no variable is set', () => {
    expect(resolveDescription(undefined, undefined, 'from config')).toEqual({ text: 'from config' })
  })

  test('nothing set means no description: the default text applies', () => {
    expect(resolveDescription(undefined, undefined, undefined)).toEqual({ text: undefined })
    expect(resolveDescription()).toEqual({ text: undefined })
  })

  test('a source that is set wins even when empty, and then no description is set', () => {
    // As the owner and the session name: an empty variable does not fall
    // through to the config field, it switches its description off.
    expect(resolveDescription('', 'shared', 'from config')).toEqual({ text: undefined })
    expect(resolveDescription('   ', undefined, 'from config')).toEqual({ text: undefined })
    expect(resolveDescription('\u0000\u0007', 'shared')).toEqual({ text: undefined })
  })

  test('a null source is absent, as a missing one is', () => {
    expect(resolveDescription(null, undefined, 'from config')).toEqual({ text: 'from config' })
  })

  test('a description as written is used without a warning', () => {
    const text = 'Keeps the logs of the orders server. Ask it what happened in a time range.'
    expect(resolveDescription(text)).toEqual({ text })
    expect(resolveDescription('a'.repeat(DESCRIPTION_LIMIT))).toEqual({
      text: 'a'.repeat(DESCRIPTION_LIMIT),
    })
  })

  test('a description cleaning changed is used as cleaned, with one warning', () => {
    expect(resolveDescription('line one\nline  two\t')).toEqual({
      text: 'line one line two',
      warning:
        'the description was cleaned: it is registered as one line of plain text, with one space wherever it had line breaks, tabs, control characters or several spaces',
    })
  })

  test('a description over the limit is cut to it, and the warning names both lengths', () => {
    expect(resolveDescription('a'.repeat(DESCRIPTION_LIMIT + 112))).toEqual({
      text: 'a'.repeat(DESCRIPTION_LIMIT),
      warning: 'the description was shortened: it had 612 characters and its first 500 are registered',
    })
  })

  test('cleaned and shortened is still one warning, with the length after cleaning', () => {
    const resolved = resolveDescription(`${'abcd '.repeat(120)}\n`)
    expect(resolved.text).toBe(cleanDescription('abcd '.repeat(120)))
    expect(codePoints(resolved.text ?? '')).toBe(499)
    expect(resolved.warning).toBe(
      'the description was cleaned and shortened: it had 599 characters after cleaning and its first 500 are registered',
    )
  })

  test('the result is what cleanDescription gives, for every vector', () => {
    for (const vector of vectors.clean) {
      const resolved = resolveDescription(vector.in)
      expect(resolved.text).toBe(vector.out === '' ? undefined : vector.out)
      // A warning exactly when cleaning changed a description that is used.
      expect(resolved.warning !== undefined).toBe(vector.out !== '' && vector.out !== vector.in)
    }
  })

  test('a value that is not text is ignored with a warning, and never throws', () => {
    for (const value of [42, true, ['a'], { text: 'a' }]) {
      expect(resolveDescription(value, 'shared')).toEqual({
        text: undefined,
        warning: 'the description is not text; it is ignored and the default is registered',
      })
    }
  })
})
