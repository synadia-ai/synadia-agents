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

// The rule as it reads, step by step over the whole text: every code point
// replaced, then the spaces, then the cut. The cleaning builds its line
// only as far as the limit, and must give exactly this for every text.
function byTheRule(text: string): string {
  let line = ''
  for (const unit of text) {
    const lone = unit.length === 1 && unit >= '\ud800' && unit <= '\udfff'
    const point = lone ? '�' : unit
    const kept = point === '‌' || point === '‍'
    line += !kept && /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]$/u.test(point) ? ' ' : point
  }
  line = line.replace(/ +/g, ' ').replace(/^ | $/g, '')
  const points = Array.from(line)
  if (points.length <= DESCRIPTION_LIMIT) return line
  return points.slice(0, DESCRIPTION_LIMIT).join('').replace(/ $/, '')
}

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

  test('a surrogate that is not part of a pair becomes U+FFFD, and that counts as cleaned', () => {
    // A text cut inside an emoji ends on half of a pair.
    expect(cleanDescription('cut in an emoji \ud83d')).toBe('cut in an emoji \ufffd')
    expect(cleanDescription('a\udc80b')).toBe('a\ufffdb')
    // Each half of a reversed pair is alone; a half before a pair is too.
    expect(cleanDescription('\udc00\ud83d')).toBe('\ufffd\ufffd')
    expect(cleanDescription('\ud83d\u{1F44D}')).toBe('\ufffd\u{1F44D}')
    expect(resolveDescription('cut in an emoji \ud83d')).toEqual({
      text: 'cut in an emoji \ufffd',
      warning:
        'the description was cleaned: it is registered as one line of plain text, with one space wherever it had line breaks, tabs, control characters or several spaces, and U+FFFD wherever it had half of a surrogate pair',
    })
    // A pair stays a pair, and U+FFFD itself stays: nothing to warn of.
    expect(resolveDescription('ok \u{1F44D} \ufffd')).toEqual({ text: 'ok \u{1F44D} \ufffd' })
  })

  test('a cleaned description is well-formed text, whatever came in', () => {
    // encodeURIComponent throws on a surrogate that is not part of a pair.
    for (const vector of vectors.clean) {
      expect(() => encodeURIComponent(cleanDescription(vector.in))).not.toThrow()
    }
    // Counted and cut as the code points they become.
    expect(cleanDescription('\ud83d'.repeat(DESCRIPTION_LIMIT + 3))).toBe('\ufffd'.repeat(DESCRIPTION_LIMIT))
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

  test('every vector is what the rule gives, step by step', () => {
    for (const vector of vectors.clean) {
      expect(byTheRule(vector.in)).toBe(vector.out)
    }
  })

  test('at the cut: 499 to 502 code points, with a space, a joiner, an astral code point or half a pair there', () => {
    const a = (count: number): string => 'a'.repeat(count)
    const astral = '\u{1F44D}'
    // A space as code point 500 goes, so 499 stay; as 499 it stays inside.
    expect(cleanDescription(`${a(498)} b`)).toBe(`${a(498)} b`)
    expect(cleanDescription(`${a(499)} b`)).toBe(a(499))
    expect(cleanDescription(`${a(500)} b`)).toBe(a(500))
    expect(cleanDescription(`${a(498)} bc`)).toBe(`${a(498)} b`)
    // Spaces after code point 500 are no part of the text: nothing is cut.
    expect(cleanDescription(`${a(500)} `)).toBe(a(500))
    expect(cleanDescription(`${a(499)} \n`)).toBe(a(499))
    // A joiner counts as the code point it is.
    expect(cleanDescription(`${a(499)}‍`)).toBe(`${a(499)}‍`)
    expect(cleanDescription(`${a(499)}‍b`)).toBe(`${a(499)}‍`)
    expect(cleanDescription(`${a(500)}‍`)).toBe(a(500))
    expect(cleanDescription(`${a(498)} ‌b`)).toBe(`${a(498)} ‌`)
    // An astral code point is one, and is kept or cut whole.
    expect(cleanDescription(`${a(499)}${astral}`)).toBe(`${a(499)}${astral}`)
    expect(cleanDescription(`${a(499)}${astral}b`)).toBe(`${a(499)}${astral}`)
    expect(cleanDescription(`${a(500)}${astral}`)).toBe(a(500))
    expect(cleanDescription(`${a(498)} ${astral}${astral}`)).toBe(`${a(498)} ${astral}`)
    // Half of a pair counts as the U+FFFD it becomes.
    expect(cleanDescription(`${a(499)}\ud83d`)).toBe(`${a(499)}�`)
    expect(cleanDescription(`${a(499)}\ud83db`)).toBe(`${a(499)}�`)
    expect(cleanDescription(`${a(500)}\udc4d`)).toBe(a(500))
    expect(cleanDescription(`${a(499)} \ud83d`)).toBe(a(499))

    // And every pair of these around the cut, against the rule.
    const around = ['b', ' ', '  ', '\t', '\n', ' ', '﻿', '‌', '‍', astral, '\ud83d', '\udc4d', '�']
    for (let before = 496; before <= 502; before++) {
      for (const first of around) {
        for (const second of around) {
          for (const end of ['', 'z', ' ']) {
            const text = `${a(before)}${first}${second}${end}`
            if (cleanDescription(text) !== byTheRule(text)) {
              throw new Error(`differs from the rule: ${before} letters, then ${JSON.stringify(`${first}${second}${end}`)}`)
            }
          }
        }
      }
    }
  })

  test('a run of spaces is read to its end, however long, and adds one space or none', () => {
    const run = ' \t '.repeat(50_000)
    expect(cleanDescription(`${run}a${run}b${run}`)).toBe('a b')
    expect(cleanDescription(`${'a'.repeat(500)}${run}`)).toBe('a'.repeat(500))
    expect(cleanDescription(`${'a'.repeat(499)}${run}b`)).toBe('a'.repeat(499))
  })

  test('a text of 10 MB costs what its first 500 code points cost', () => {
    // The line is built only as far as the limit and the pass ends at the
    // first code point that does not fit, so nothing the size of the text
    // is built or counted. Shown by time, since a string cannot say how
    // much of it was read: built whole and counted twice, this text took
    // half a second and 700 MB; read up to the limit, it takes a few
    // milliseconds at most. The best of three, so that a pause of the
    // machine does not fail it.
    const text = 'abcd '.repeat(2 * 1024 * 1024)
    let best = Number.POSITIVE_INFINITY
    let resolved = resolveDescription('')
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now()
      resolved = resolveDescription(text)
      best = Math.min(best, performance.now() - started)
    }
    expect(best).toBeLessThan(100)
    expect(resolved.text).toBe('abcd '.repeat(100).trimEnd())
    expect(resolved.warning).toMatch(/^the description was shortened: /)
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
        'the description was cleaned: it is registered as one line of plain text, with one space wherever it had line breaks, tabs, control characters or several spaces, and U+FFFD wherever it had half of a surrogate pair',
    })
  })

  test('a description over the limit is cut to it, and the warning names the limit', () => {
    expect(resolveDescription('a'.repeat(DESCRIPTION_LIMIT + 112))).toEqual({
      text: 'a'.repeat(DESCRIPTION_LIMIT),
      warning: 'the description was shortened: it had more than 500 characters and its first 500 are registered',
    })
  })

  test('cleaned and shortened is still one warning', () => {
    // Cleaned within what is registered: a space where the line break was.
    const resolved = resolveDescription(`abcd\n${'abcd '.repeat(120)}`)
    expect(resolved.text).toBe('abcd '.repeat(100).trimEnd())
    expect(codePoints(resolved.text ?? '')).toBe(499)
    expect(resolved.warning).toBe(
      'the description was cleaned and shortened: it had more than 500 characters after cleaning and its first 500 are registered',
    )
  })

  test('shortened only, when what is registered is how the text began', () => {
    // A text over the limit is not read to its end: what cleaning would
    // have changed past the cut is not looked at.
    expect(resolveDescription(`${'abcd '.repeat(120)}\n\ttail`)).toEqual({
      text: 'abcd '.repeat(100).trimEnd(),
      warning: 'the description was shortened: it had more than 500 characters and its first 500 are registered',
    })
  })

  test('spaces past code point 500 are cleaned away, not cut: no word of shortening', () => {
    const resolved = resolveDescription(`${'a'.repeat(DESCRIPTION_LIMIT)} \n`)
    expect(resolved.text).toBe('a'.repeat(DESCRIPTION_LIMIT))
    expect(resolved.warning).toMatch(/^the description was cleaned: /)
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
