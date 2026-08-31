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

Inside the monorepo most consumers (`agents/*`, `examples/*`) refer to
both packages via `file:` links in their `package.json`. The exceptions
pin the published npm `^semver` instead: `agents/acp`, `agents/codex`,
and `agents/opencode`, plus `agents/claude-code`, which must stay
pinned (see `devtools/.devmodeignore`). For the `file:`-linked
consumers Bun **copies** those links at install time rather than
symlinking, so an edit to either SDK is invisible to a consumer until
that consumer's install is refreshed against a freshly built `dist/`.

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

## Running the SDK-side examples

Both SDKs ship runnable example scripts next to the package source —
useful as smoke targets while iterating on the SDK or as starting
shapes for new agents:

| Path | What it does |
| --- | --- |
| `client-sdk/typescript/examples/01-discover.ts` … `05-liveness.ts` | Caller-side demos against a running agent. |
| `client-sdk/typescript/examples/_run-reference-agent.ts` | Spec-compliant `ReferenceAgent` to point the caller demos at. |
| `agent-sdk/typescript/examples/01-echo.ts` | Minimal `AgentService` echo agent. |

Each script supports `$NATS_CONTEXT`, `$NATS_URL`, or falls back to
`nats://127.0.0.1:4222`. Run with:

```sh
bun client-sdk/typescript/examples/_run-reference-agent.ts
bun agent-sdk/typescript/examples/01-echo.ts
```

## Installing extension-style agent plugins locally (PI, OpenClaw, Claude Code)

`agents/pi/`, `agents/openclaw/`, and `agents/claude-code/` are
extension/plugin packages that get loaded by their host application
(`pi`, `openclaw`, the Claude Code MCP runtime). When `pi` or
`openclaw` loads its extension it follows the `file:` link in the
extension's `package.json` back to the SDK source — so both SDKs need
a current `dist/` when the extension is installed. `agents/claude-code`
is the exception: it pins the published `^semver` SDKs (its `start`
script runs `bun install` at server launch), so local SDK edits never
reach it — exercise them through pi/openclaw or the examples instead.

Other agent packages in `agents/`, including `agents/flue/`,
`agents/eve/`, `agents/opencode/`, and `agents/codex/`, run as
sidecars or wrappers rather than host-loaded extensions; follow their
per-agent READMEs for local startup.

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

## Releasing the SDKs

`main` keeps `file:` links for most consumers so contributors editing
the SDK see their changes live in the agents/examples without any flip
step (the npm-pinned consumers — acp, codex, opencode, claude-code —
track published versions instead). That's also why a fresh `npm
publish` of any consumer would ship `file:` refs that break for npm
users — published tarballs need `^semver` instead. The
[`devtools/devmode.sh`](devtools/devmode.sh) script bridges the two
states.

```sh
./devtools/devmode.sh status        # what's currently flipped where
./devtools/devmode.sh off           # flip every tracked consumer to ^semver
./devtools/devmode.sh on            # flip back to file: (the default state)
./devtools/devmode.sh check-release # exit 0 iff every dep is at its SDK's ^semver
```

The script discovers consumers automatically — every `package.json`
under `examples/`, `agents/`, `client-sdk/`, and `agent-sdk/` that
depends on a tracked SDK gets flipped. Names listed in
`devtools/.devmodeignore` are skipped (currently `dspy`, which lives on
`file:` permanently, and `claude-code`, which must stay on `^semver`
pins because the plugin marketplace ships only its subtree, where
`file:` cannot resolve).

### The release ladder (one cycle)

Order matters: caller `@synadia-ai/agents` first because the host SDK
depends on it (the flip pins it to the caller's current `^semver`);
agent harnesses and headless examples follow once both SDKs are on
npm. Each `npm publish` is a separate user-approval gate — read the
dry-run output before pulling the trigger.

```sh
# 1. Pre-flight: confirm versions, identity, and tarball shape.
git status                                       # tree must be clean
jq -r '.version' client-sdk/typescript/package.json
jq -r '.version' agent-sdk/typescript/package.json
npm whoami                                       # the @synadia-ai publish identity

# 2. Build dist/ artifacts fresh.
(cd client-sdk/typescript && bun install && bun run build)
(cd agent-sdk/typescript  && bun install && bun run build)

# 3. Flip to release mode.
./devtools/devmode.sh off

# 4. Publish caller, then host. Inspect each dry-run before publishing.
(cd client-sdk/typescript && npm publish --dry-run && npm publish)
(cd agent-sdk/typescript  && npm publish --dry-run && npm publish)

# 5. Publish each consumer that needs to ship.
#    OpenClaw — `prepublishOnly` builds dist/ with tsup, so install its
#    devDeps first. The tarball ships dist/ + sources, never node_modules;
#    the SDKs are normal registry dependencies. Don't re-add
#    bundleDependencies without a real vendoring step — declaring it makes
#    npm skip fetching the SDKs, and the installed plugin fails at runtime.
(cd agents/openclaw && bun install && npm publish --dry-run && npm publish)
#    PI — plain extension sources, no build step; nothing to install.
(cd agents/pi       && npm publish --dry-run && npm publish)
#    Plain plugin packages with Bun TypeScript entrypoints — no build
#    step; nothing from node_modules ships. Their `bun install` proves
#    the flipped ^semver deps resolve from the registry and refreshes
#    each committed bun.lock.
(cd agents/opencode && bun install && npm publish --dry-run && npm publish)
(cd agents/codex    && bun install && npm publish --dry-run && npm publish)
(cd agents/eve      && bun install && npm publish --dry-run && npm publish)
(cd agents/acp      && bun install && npm publish --dry-run && npm publish)
(cd agents/flue     && bun install && npm publish --dry-run && npm publish)
#    Grok — its only dependency is `@synadia-ai/acp-nats-channel:
#    file:../acp`, which devmode.sh does NOT flip (it tracks only the
#    two SDK deps). Point it at the published ACP ^semver by hand
#    before publishing, and back to file:../acp after.
(cd agents/grok     && npm publish --dry-run && npm publish)
#    Plain (examples/pi-headless, examples/claude-code-headless) — the
#    `prepack` hook builds dist/ on its own.
(cd examples/pi-headless           && npm publish --dry-run && npm publish)
(cd examples/claude-code-headless  && npm publish --dry-run && npm publish)

# 6. Flip back to dev mode and commit any non-empty diff.
./devtools/devmode.sh on
git status
```

### Gotchas the script accounts for (so you don't trip over them)

- **`agent-sdk/typescript`'s self-dep on caller.** Discovery scans
  `agent-sdk/` and `client-sdk/` in addition to `examples/` and
  `agents/`. Without that, the host SDK would publish with a `file:`
  ref to caller, which breaks every npm consumer of the host.
- **`bun install --silent` can spin on `agents/openclaw`.** Its
  `peerDependencies: { openclaw: "" }` (empty version range) sends bun
  into a 100%-CPU walk. Each per-consumer `bun install` is wrapped in
  `timeout 60` (override with `BUN_INSTALL_TIMEOUT=…`); the script
  prints a `⏱ timed out` line and continues.
- **`^semver` `bun install` failures pre-publish are normal.** Until
  the freshly bumped SDK versions are on npm, `devmode.sh off` flips
  the deps but the follow-on `bun install` can't resolve the new
  `^x.y.z` from the registry. The script treats those as best-effort;
  the package.json flips themselves succeed and that's what
  `npm publish` reads.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cannot find module '@synadia-ai/agent-service'` at startup | Consumer's install is older than the host SDK split | `bun install` in the consumer dir |
| `Cannot find module '.../agent-sdk/typescript/node_modules/@synadia-ai/agents/dist/index.cjs'` | Caller's `dist/` not present in agent-sdk's nested install | `(cd client-sdk/typescript && bun run build) && (cd agent-sdk/typescript && bun install)` |
| Edits to SDK source aren't reflected when running an example or extension | Consumer's `node_modules` carries a stale copy | Rebuild the SDK(s) and re-`bun install` in the consumer |
| `Failed to resolve entry for package "@synadia-ai/agents"` from vitest | Stale CI-style install without sibling SDK source | `bun install` in the sibling SDK directory |
| `./devtools/devmode.sh off` hangs on `agents/openclaw` | bun's empty-string peer-dep walk | The script auto-times-out at 60 s; kill manually if you ran an older version |
| `./devtools/devmode.sh off` reports `bun install` failures with `404` / `No version matching ^x.y.z` | Pre-publish — the SDKs aren't on npm yet | Expected; the package.json flips succeeded. Run again after `npm publish` to refresh lockfiles. |

## Why not workspaces?

A Bun workspace would symlink the `file:` packages and remove most of
the rebuild/reinstall dance, at the cost of a non-trivial restructure
(root `package.json`, repo-wide `bun.lock`, and a publish workflow that
correctly handles workspace deps). The current layout keeps each
package self-contained and publishable on its own.
