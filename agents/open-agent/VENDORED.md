# Vendored sources

This package vendors a subset of
[`vercel-labs/open-agents`](https://github.com/vercel-labs/open-agents)
(Apache-2.0). The vendored copy is unmodified — every `@open-agents/sandbox`
import in the vendored agent code is rewritten by `tsconfig.json` `paths`
to resolve to our custom barrel at `vendor/sandbox/index.ts`, which
re-exports the verbatim interface + types and our `connectSandbox`
factory + `LocalSandbox` implementation.

## Pinned upstream

- Source: `https://github.com/vercel-labs/open-agents`
- Commit: `56ddf9465553dd76f2156abc241bd75a1d82ed0d`
- Date: 2026-01 (current `origin/main` at vendoring time)
- Upstream LICENSE.md is preserved at `vendor/agent/LICENSE.md`.

## Files copied verbatim

- `packages/agent/**` → `vendor/agent/**`
- `packages/sandbox/interface.ts` → `vendor/sandbox/interface.ts`
- `packages/sandbox/types.ts` → `vendor/sandbox/types.ts`
- `LICENSE.md` → `vendor/agent/LICENSE.md`

## Files NOT copied

- `packages/sandbox/git.ts` — sandbox-side helper for the upstream web
  app's git flows. The vendored agent does not import it.
- `packages/sandbox/factory.ts`, `packages/sandbox/index.ts`,
  `packages/sandbox/vercel/**` — replaced by our custom
  factory + LocalSandbox.

## Files removed after copy

- `vendor/agent/tsconfig.json` — extends `@open-agents/tsconfig`,
  which doesn't exist in this repo, and breaks Bun's tsconfig
  walking (the resolver picks it up for files under
  `vendor/agent/**` and stops looking for the parent tsconfig that
  carries our `@open-agents/sandbox` path mapping). Re-vendoring
  upstream → re-delete this file as part of the refresh.

## Custom files (NOT from upstream)

- `vendor/sandbox/factory.ts` — `connectSandbox(state)` dispatches
  `state.type === "local"` to `connectLocalSandbox`. `state.type ===
  "vercel"` throws with a hint to use `examples/open-agent-vercel`.
- `vendor/sandbox/index.ts` — barrel that re-exports the verbatim
  `interface.ts` / `types.ts` symbols, our `connectSandbox`, and the
  `LocalSandbox` types. Does NOT re-export Vercel.
- `vendor/sandbox/local.ts` — `LocalSandbox` implementation backed by
  `node:fs/promises` and `Bun.spawn`. Not isolated; trust the operator.
- `vendor/agent/LICENSE.md` — upstream Apache-2.0 license preserved
  alongside the vendored sources.

## Refresh procedure

1. `git fetch upstream` in a local clone of `vercel-labs/open-agents`
   and pick the commit you want to pin.
2. `cp -r path/to/open-agents/packages/agent/. vendor/agent/`.
3. `cp path/to/open-agents/packages/sandbox/interface.ts
   path/to/open-agents/packages/sandbox/types.ts vendor/sandbox/`.
4. `cp path/to/open-agents/LICENSE.md vendor/agent/LICENSE.md`.
5. Run `bun test` and `bun run typecheck`.
6. Update the **Pinned upstream** block above with the new SHA.

If upstream renames or removes files, this list should be updated to
match — the goal is "verbatim subtree, plus our own factory" — anything
else is a vendoring bug.
