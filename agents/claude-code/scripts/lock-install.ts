#!/usr/bin/env bun
// Hold CI's npm install of the packed SDKs to the committed bun.lock.
//
// Bun cannot install this lock directly: 1.3.14 (the version that builds the
// committed runtime bundle) hangs on the lock's `file:` SDK cycle, and later
// releases refuse its `file:../../` folder paths. CI therefore installs the
// packed SDK tarballs with npm, and this script keeps that install on the
// locked external versions so a fresh build reproduces runtime/server.js:
//
//   bun ./scripts/lock-install.ts pin     writes npm `overrides` into package.json
//   bun ./scripts/lock-install.ts verify  fails unless every installed external
//                                         sits at a bun.lock position with that
//                                         position's version and integrity
//
// `pin` only rewrites the CI checkout's manifest; nothing it writes is committed.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_SCOPE = '@synadia-ai/'

interface LockedPackage {
  /** Package names from the top-level node_modules down, e.g. `["eslint", "ajv"]`. */
  readonly path: readonly string[]
  readonly version: string
  readonly integrity: string
}

interface OverrideNode {
  version?: string
  readonly children: Map<string, OverrideNode>
}

type Override = string | { [key: string]: Override }

function fail(message: string): never {
  console.error(`lock-install: ${message}`)
  process.exit(1)
}

/** Split a bun.lock key or node_modules path into package names. */
function splitNames(key: string): string[] {
  const parts = key.split('/')
  const names: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    names.push(part.startsWith('@') ? `${part}/${parts[++i] ?? ''}` : part)
  }
  return names
}

/** bun.lock is JSON plus trailing commas; drop only commas outside strings. */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (inString) {
      out += char
      if (char === '\\') out += text[++i] ?? ''
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    if (char === ',') {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next]!)) next++
      if (text[next] === '}' || text[next] === ']') continue
    }
    out += char
  }
  return out
}

/**
 * Locked externals keyed by their position (`parent/child`). Only the `file:`
 * SDK links are left out; positions nested under an SDK stay, so `verify`
 * checks anything npm ever installs there.
 */
function readLock(): Map<string, LockedPackage> {
  const text = stripTrailingCommas(readFileSync(join(root, 'bun.lock'), 'utf8'))
  const lock = JSON.parse(text) as { packages: Record<string, unknown[]> }
  const locked = new Map<string, LockedPackage>()
  for (const [key, entry] of Object.entries(lock.packages)) {
    const [ident, , , integrity] = entry
    if (typeof ident !== 'string') fail(`unexpected bun.lock entry for ${key}`)
    const version = ident.slice(ident.lastIndexOf('@') + 1)
    if (version.startsWith('file:')) continue
    if (typeof integrity !== 'string') fail(`bun.lock entry ${key} has no integrity`)
    locked.set(key, { path: splitNames(key), version, integrity })
  }
  return locked
}

function serialize(node: OverrideNode, self: string | undefined): Override | undefined {
  if (node.children.size === 0) return self
  const out: { [key: string]: Override } = {}
  if (self !== undefined) out['.'] = self
  for (const [name, child] of node.children) {
    const value = serialize(child, child.version)
    if (value !== undefined) out[name] = value
  }
  return out
}

function pin(): void {
  const manifestPath = join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    overrides?: unknown
  }
  if (manifest.overrides !== undefined) fail('package.json already has overrides')
  const direct = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])

  // One override per locked position: a nested version is scoped by its full
  // ancestor chain, so it never leaks onto a same-named package elsewhere.
  const locked = readLock()
  const tree = new Map<string, OverrideNode>()
  let pinned = 0
  for (const pkg of locked.values()) {
    // Positions under a packed SDK are its devDependencies, which npm never
    // installs; an override there would have to reference the tarball edge.
    if (pkg.path.slice(0, -1).some((name) => name.startsWith(INTERNAL_SCOPE))) continue
    let level = tree
    let node: OverrideNode | undefined
    for (const name of pkg.path) {
      node = level.get(name) ?? { children: new Map() }
      level.set(name, node)
      level = node.children
    }
    node!.version = pkg.version
    pinned++
  }

  const overrides: { [key: string]: Override } = {}
  for (const [name, node] of tree) {
    // A direct dependency is already exact; reference it rather than repeat it.
    const self = direct.has(name)
      ? node.children.size > 0
        ? `$${name}`
        : undefined
      : node.version
    const value = serialize(node, self)
    if (value !== undefined) overrides[name] = value
  }
  manifest.overrides = overrides
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`pinned ${pinned} locked positions`)
}

function verify(): void {
  const locked = readLock()
  const installed = JSON.parse(
    readFileSync(join(root, 'node_modules', '.package-lock.json'), 'utf8'),
  ) as { packages: Record<string, { version?: string; integrity?: string; link?: boolean }> }
  const mismatches: string[] = []
  let checked = 0
  for (const [path, meta] of Object.entries(installed.packages)) {
    if (!path.startsWith('node_modules/') || meta.link) continue
    const names = path
      .split('node_modules/')
      .filter(Boolean)
      .map((part) => part.replace(/\/$/, ''))
    // The packed SDKs themselves are not in bun.lock; anything below them is.
    if (names.length === 1 && names[0]!.startsWith(INTERNAL_SCOPE)) continue
    const key = names.join('/')
    const pkg = locked.get(key)
    if (pkg === undefined) {
      mismatches.push(`${key}@${meta.version}: no bun.lock entry at this position`)
    } else if (pkg.version !== meta.version) {
      mismatches.push(`${key}: installed ${meta.version}, bun.lock has ${pkg.version}`)
    } else if (pkg.integrity !== meta.integrity) {
      mismatches.push(`${key}@${meta.version}: integrity differs from bun.lock`)
    }
    checked++
  }
  if (mismatches.length > 0) {
    fail(`install does not match bun.lock:\n  ${mismatches.join('\n  ')}`)
  }
  console.log(`verified ${checked} installed externals against bun.lock positions`)
}

const command = process.argv[2]
if (command === 'pin') pin()
else if (command === 'verify') verify()
else fail('usage: bun ./scripts/lock-install.ts pin|verify')
