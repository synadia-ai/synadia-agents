#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeRuntimeBundle } from './runtime-bundle'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = join(root, 'runtime')
const output = join(runtimeDir, 'server.js')
mkdirSync(runtimeDir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(root, 'server.ts')],
  outdir: runtimeDir,
  target: 'bun',
  format: 'esm',
  minify: true,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error('bundle build failed')
}

writeFileSync(output, normalizeRuntimeBundle(readFileSync(output, 'utf8')))
console.log(`built ${output}`)
