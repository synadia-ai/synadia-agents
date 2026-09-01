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

Inside the monorepo the dependency state is deliberately mixed. Most
consumers (`agents/*`, `examples/*`) use `file:` links while some, such
as `agents/acp`, `agents/codex`, and `agents/opencode`, may point at the
currently published SDKs and receive branch artifacts as a CI overlay.
`agents/claude-code` is excluded from `devmode.sh` because its
marketplace subtree must be staged explicitly; during coordinated
development it may temporarily use branch-local SDK inputs. These are
development inputs, not publishable manifests. For `file:` consumers,
Bun **copies** those links at install time rather than symlinking, so an
SDK edit is invisible until the consumer is refreshed against a newly
built `dist/`.

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
extension/plugin packages loaded by their host application (`pi`,
`openclaw`, or the Claude Code MCP runtime). PI and OpenClaw follow
their branch-local SDK links, so both SDKs need a current `dist/` when
the extension is installed. Claude Code is different: the marketplace
runs the committed self-contained `runtime/server.js`; it does not run
`bun install` at startup. To exercise branch SDK changes there, install
the packed branch SDK artifacts, rebuild the runtime, and run the
bundle verification described in `agents/claude-code/README.md`.

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

## Local dependency wiring helper

[`devtools/devmode.sh`](devtools/devmode.sh) is a convenience for local
development. It mutates checkout manifests between `file:` links and
`^semver` SDK ranges and may refresh locks with an ordinary `bun
install`. It is **not release tooling**, and neither `off` nor
`check-release` proves that an artifact is publishable.

```sh
./devtools/devmode.sh status        # inspect local wiring
./devtools/devmode.sh off           # local registry-compatibility exercise
./devtools/devmode.sh on            # restore local file: wiring where tracked
./devtools/devmode.sh check-release # checks only the helper's ^semver state
```

The helper tracks only `@synadia-ai/agents` and
`@synadia-ai/agent-service`. It does not cover Grok's dependency on ACP
or any Python source override. Entries in `devtools/.devmodeignore`,
including the Claude Code marketplace subtree, are not touched. A
release must therefore use the clean staging flow below and validate
the complete graph independently.

## Releasing SDKs and integrations

The authoritative rollout contract is
[`docs/sdk-release-rollout-roadmap.md`](docs/sdk-release-rollout-roadmap.md).
Release inputs come from a clean, reviewed commit, but publishable
manifests and locks are generated in a separate clean staging directory.
Never publish a checkout temporarily rewritten by `devmode.sh`, `npm pkg
set`, or a CI artifact overlay.

### Inputs required before publication

- Record the source commit and freeze approved external dependencies,
  build tools, runtimes, and release actions.
- Measure and record the real dependency-cooldown duration, enforcement
  point, and exact internal-package exception syntax. This is required
  before the first registry publication; it does not block branch
  implementation or local artifact rehearsal.
- Choose candidate versions and confirm each one is absent from npm or
  PyPI and from repository tags. Every changed package whose current
  version already exists must be bumped. Never reuse a version whose
  bytes reached a registry.
- Verify the npm publisher and PyPI trusted-publisher configuration.
  Every npm publication remains a separate explicit approval.

### Dependency order

Publish and stop on failure in this order:

1. TypeScript caller SDK, `@synadia-ai/agents`.
2. TypeScript host SDK, `@synadia-ai/agent-service`, selecting the exact
   caller version.
3. After both SDKs exist: ACP, Codex, OpenCode, Eve, Flue, OpenClaw, PI,
   PI headless, and Claude Code headless. Their release manifests select
   both SDKs by exact version.
4. Grok Build after ACP, selecting the exact ACP version.
5. The Claude Code marketplace subtree after its exact SDK inputs,
   committed runtime bundle, lock, package manifest, and plugin
   descriptor have been validated together.

The Python order is caller SDK → AgentService SDK → DeerFlow, again with
exact internal versions. The language ladders may proceed independently,
but no dependent may pass a failed prerequisite.

### Stage, validate, and build once

The release staging process must:

1. Copy the reviewed source into a clean directory and transform every
   internal edge to an exact candidate version. It must cover the SDK
   pair, all integrations and published headless packages, Grok → ACP,
   and the Claude marketplace subtree.
2. Create registry-only Python inputs by removing
   `[tool.uv.sources]`/editable SDK overrides from staged projects and
   selecting exact Python SDK versions.
3. Remove or constrain `latest`, wildcard, empty, local, workspace, Git,
   and editable dependency specifications. Generate immutable locks;
   OpenClaw and PI receive their release locks only after their cyclic
   development links have been replaced by registry versions.
4. Run one cross-ecosystem graph validator over staged manifests and
   locks. Fail on a missing/stale lock or any forbidden dependency, and
   inspect package allowlists for unintended files.
5. Install with `bun install --frozen-lockfile` and `uv sync --locked`.
   Builds and tests must fail rather than rewrite a lock.
6. Run each build or lifecycle build exactly once, then create each npm
   tarball and Python wheel/sdist exactly once. Record SHA-256 digests,
   package manifests, and provenance/SBOM evidence.
7. Copy the artifacts to clean environments, install only from those
   artifacts, and run identity-free, signed, strict-trust, package-import,
   CLI/runtime, and integration smokes. Test both the Python wheel and
   sdist without source/editable fallback.

Do not use `npm publish --dry-run && npm publish` from a package
directory: lifecycle hooks can rebuild between the inspection and the
upload. Inspect and approve the already-created tarball, then publish
that exact hashed file:

```sh
npm publish /absolute/path/to/approved-package.tgz --tag next
```

Use `next` for every npm candidate. Existing packages keep their old
`latest` during aging; first-publish packages intentionally have no
`latest` until cutover. The `next` tag is not a security quarantine—the
normal cooldown still applies to the exact uploaded version.

Python candidates are public immediately through the approved tag
workflows. Those workflows must build, artifact-test, and publish the
same wheel/sdist bytes with `uv --locked` semantics. If a quieter aging
window is wanted, manually delete only the generated GitHub Release
entry after confirming PyPI and recording its artifact digests. Keep
the source tag and PyPI files; recreate the GitHub Release from the same
tag and digests at cutover.

Claude Code is not published to npm. Validate the exact marketplace
subtree as the release artifact: synchronized `package.json` and
`.claude-plugin/plugin.json` versions, no local dependency references,
an immutable lock, a freshly verified committed `runtime/server.js`, and
a clean marketplace install smoke.

After every final artifact has aged, remove the temporary internal-only
cooldown exception, repeat clean frozen registry installs under the
normal policy, and verify recorded digests. Move `latest` to those
already-published npm bytes; do not rebuild or republish at cutover.

### Development-helper caveats

- The host SDK's dependency on the caller and the caller's test-only
  dependency on the host form a local cycle. Release staging must still
  transform and validate both package manifests.
- OpenClaw's current peer is `openclaw >=2026.5.4 <2027`; PI's is
  `@earendil-works/pi-coding-agent >=0.84.0 <0.85.0`. Both are bounded,
  and neither package has `bundleDependencies`. Their release locks must
  be generated after exact registry SDK selection; do not work around
  the local cycle by declaring the SDKs bundled.
- Re-running `devmode.sh off` after it has already flipped every tracked
  manifest does not refresh locks—it exits because nothing changed.
- A successful helper `check-release` accepts `^semver`, ignores Grok,
  Python, and Claude Code, and is therefore never a release gate.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cannot find module '@synadia-ai/agent-service'` at startup | Consumer's install is older than the host SDK split | `bun install` in the consumer dir |
| `Cannot find module '.../agent-sdk/typescript/node_modules/@synadia-ai/agents/dist/index.cjs'` | Caller's `dist/` not present in agent-sdk's nested install | `(cd client-sdk/typescript && bun run build) && (cd agent-sdk/typescript && bun install)` |
| Edits to SDK source aren't reflected when running an example or extension | Consumer's `node_modules` carries a stale copy | Rebuild the SDK(s) and re-`bun install` in the consumer |
| `Failed to resolve entry for package "@synadia-ai/agents"` from vitest | Stale CI-style install without sibling SDK source | `bun install` in the sibling SDK directory |
| Local Bun install hangs on the OpenClaw/PI SDK cycle | Both branch SDKs are connected by `file:` development edges | Use the branch artifact-overlay workflow for development. Generate the release lock only after staged manifests select exact registry SDKs. |
| `devmode.sh check-release` passes but the graph validator rejects the package | The helper accepts `^semver` and covers only the SDK pair | Fix the clean staged manifest/lock; never publish the helper-mutated checkout. |

## Why not workspaces?

A Bun workspace would symlink the `file:` packages and remove most of
the rebuild/reinstall dance, at the cost of a non-trivial restructure
(root `package.json`, repo-wide `bun.lock`, and a publish workflow that
correctly handles workspace deps). The current layout keeps each
package self-contained and publishable on its own.
