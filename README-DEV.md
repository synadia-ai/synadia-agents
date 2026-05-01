# Local development

Quick reference for working on the TypeScript packages in this repo
without publishing to npm. The Python side is documented in
[`client-sdk/python/CLAUDE.md`](client-sdk/python/CLAUDE.md).

The TypeScript SDK ships as **two npm packages** that always release in
lockstep:

| Path | Package | Role |
| --- | --- | --- |
| `client-sdk/typescript/` | `@synadia-ai/agents` | Caller side — discover, prompt, stream. Most consumers want only this. |
| `agent-sdk/typescript/` | `@synadia-ai/agent-service` | Host side — `AgentService`, `ReferenceAgent`, server-side wire helpers. Depends on the caller package. |

Inside the monorepo every consumer (`agents/*`, `examples/*`) refers to
both packages via `file:` links in its `package.json`. Bun **copies**
those links at install time rather than symlinking, so an edit to
either SDK is invisible to a consumer until that consumer's install is
refreshed against a freshly built `dist/`.

The same applies inside `agent-sdk/typescript/` itself: it depends on
`@synadia-ai/agents` via `file:`, so its own `node_modules` carries a
copy of the caller package that needs caller's `dist/` to be present
for the host's compiled `dist/index.cjs` to load.

The recipes below all account for this.

## Building the SDKs

Build caller first, then host (host depends on caller's `dist/`):

```sh
(cd client-sdk/typescript && bun run build)
(cd agent-sdk/typescript  && bun install && bun run build)
```

The extra `bun install` in `agent-sdk/typescript` re-copies the
freshly-built caller `dist/` into `agent-sdk/typescript/node_modules/@synadia-ai/agents/`,
which is the path host's compiled output resolves at runtime.

Skip the build commands above if neither SDK has changed since the
last build — but if you're unsure, rebuilding is cheap (~1s each).

## Running the examples

Each example has a `start` script that runs the source directly with
`bun run`. After building the SDKs, refresh the example's install so
its copy of each SDK reflects the latest `dist/`, then run:

```sh
cd examples/pi-headless    # or examples/claude-code-headless / examples/dspy
bun install
bun run start
```

`bun install` is what copies the freshly-built SDKs into the example's
`node_modules`. Without it the example silently runs against whatever
`dist/` was current at the previous install.

For the browser test client `examples/agent-web-ui` only the caller
SDK matters (it doesn't host an agent), but the install dance is the
same.

## Installing the agent plugins locally (PI, OpenClaw, Claude Code)

`agents/pi/`, `agents/openclaw/`, and `agents/claude-code/` are
extension/plugin packages that get loaded by their host application
(`pi`, `openclaw`, the Claude Code MCP runtime). When the host loads
the extension it follows the `file:` link in the extension's
`package.json` back to the SDK source — so both SDKs need a current
`dist/` when the extension is installed.

```sh
# Build the SDKs, then install the extension into its host application.
(cd client-sdk/typescript && bun run build)
(cd agent-sdk/typescript  && bun install && bun run build)

# Pi:
pi install $(pwd)/agents/pi
pi

# OpenClaw:
openclaw install $(pwd)/agents/openclaw

# Claude Code (MCP plugin):
# follow the install steps in agents/claude-code/README.md
```

If the host complains with a path like
`Cannot find module '.../agent-sdk/typescript/node_modules/@synadia-ai/agents/dist/index.cjs'`,
the missing `dist/` is in `agent-sdk/typescript/node_modules/@synadia-ai/agents/` —
re-run the SDK build sequence above (the `bun install` step in
`agent-sdk/typescript` is what populates that path).

## Editing one SDK without rebuilding the other

When iterating on caller-side code only:

```sh
(cd client-sdk/typescript && bun run build)
(cd agent-sdk/typescript  && bun install)   # refresh nested caller copy
# then refresh the consumer's install (cd to consumer dir, bun install)
```

When iterating on host-side code only:

```sh
(cd agent-sdk/typescript && bun run build)
# then refresh the consumer's install
```

## Running the test suites

The TS test suites use vitest's `resolve.alias` to resolve
`@synadia-ai/agents` and `@synadia-ai/agent-service` directly to source.
That bypasses `dist/` for tests, so the suites run fine without
building first:

```sh
(cd client-sdk/typescript && bun run check)   # typecheck + lint + format + tests
(cd agent-sdk/typescript  && bun run check)
```

`bun run check` will pull in the sibling SDK's source via path aliases.
On a fresh clone install both packages first so the transitive
`@nats-io/*` deps are available to both checkouts:

```sh
(cd client-sdk/typescript && bun install)
(cd agent-sdk/typescript  && bun install)
```

CI runs the same shape — see
[`.github/workflows/client-sdk-typescript.yml`](.github/workflows/client-sdk-typescript.yml)
and [`.github/workflows/agent-sdk-typescript.yml`](.github/workflows/agent-sdk-typescript.yml).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cannot find module '@synadia-ai/agent-service'` at startup | Consumer's install is older than the host SDK split | `bun install` in the consumer dir |
| `Cannot find module '.../agent-sdk/typescript/node_modules/@synadia-ai/agents/dist/index.cjs'` | Caller's `dist/` not present in agent-sdk's nested install | `(cd client-sdk/typescript && bun run build) && (cd agent-sdk/typescript && bun install)` |
| Edits to SDK source aren't reflected when running an example or extension | Consumer's `node_modules` carries a stale copy | Rebuild the SDK(s) and re-`bun install` in the consumer |
| `Failed to resolve entry for package "@synadia-ai/agents"` from vitest | Stale CI-style install without sibling SDK source | `bun install` in the sibling SDK directory |

## Why not workspaces?

A Bun workspace would symlink the `file:` packages and remove most of
the rebuild/reinstall dance, at the cost of a non-trivial restructure
(root `package.json`, repo-wide `bun.lock`, and a publish workflow that
correctly handles workspace deps). The current layout keeps each
package self-contained and publishable on its own.
