#!/usr/bin/env bun

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeRuntimeBundle } from './runtime-bundle'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const committed = join(root, 'runtime', 'server.js')
const temporary = mkdtempSync(join(tmpdir(), 'claude-channel-bundle-'))

try {
  const result = await Bun.build({
    entrypoints: [join(root, 'server.ts')],
    outdir: temporary,
    target: 'bun',
    format: 'esm',
    minify: true,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('bundle build failed')
  }
  if (!existsSync(committed)) throw new Error('runtime/server.js is missing; run bun run build')
  const rebuilt = normalizeRuntimeBundle(readFileSync(join(temporary, 'server.js'), 'utf8'))
  const expected = readFileSync(committed, 'utf8')
  if (rebuilt !== expected) {
    throw new Error('runtime/server.js is stale; run bun run build and commit the result')
  }

  const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version: string
  }
  const pluginManifest = JSON.parse(
    readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as { version: string }
  if (packageManifest.version !== pluginManifest.version) {
    throw new Error('package.json and .claude-plugin/plugin.json versions differ')
  }
  console.log('bundle and plugin version are current')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
