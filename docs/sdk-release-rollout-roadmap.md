# SDK identity and tracing release roadmap

- Status: active; implementation contracts resolved, release prerequisites tracked below
- Last updated: 2026-09-01
- Integration branch: `sdk-release-rollout`
- Scope: TypeScript and Python caller/host SDKs, sender identity, optional tracing, provided
  integrations, examples, and release operations

This is the persistent source of truth for the coordinated SDK rollout. Check an item only when
the evidence is linked here or in the relevant pull request or tracking issue. This file is public:
use product-neutral language, role-based operational details where practical, and no private
specification or launch links.

The rollout has five non-negotiable outcomes:

1. Existing agents and callers continue to work without sender identity or tracing.
2. Explicitly configured signers are bound to the live NATS connection and cannot silently
   downgrade or impersonate another connection user.
3. The dependency cooldown remains effective for external packages during the accelerated
   internal-package rollout.
4. Public caller and AgentService documentation teaches sender identity without unreleased product
   names, private roadmap language, or unapproved specification links.
5. Optional tracing is wire-neutral when unconfigured and cannot change authorization decisions.

## Workflow terminology

- **Integration branch:** `sdk-release-rollout`, where the coordinated feature, compatibility,
  documentation, and release work is assembled. It is pushed and retained through final cutover.
- **SDK feature PR:** an implementation change targeting the integration branch, such as tracing
  or an identity correctness fix.
- **SDK release PR:** the reviewed version, dependency, changelog, and package-content changes for
  an SDK release. It does not authorize publication.
- **Integration PR:** optional-identity/tracing compatibility and dependency changes for a provided
  integration or example.
- **Rollout PR:** the final integration-branch pull request to `main`, after the recorded registry
  contract and aging requirements are complete.

## Current state

- [x] Sender-identity implementations exist in both SDK pairs
      ([TypeScript](../client-sdk/typescript/src/identity/),
      [Python](../client-sdk/python/src/synadia_ai/agents/identity/)).
- [x] The Python [identity workbook](../examples/identity-workbook/python/README.md) demonstrates
      signed Echo, signed Hello-to-Echo forwarding, and identity-free calls.
- Review status: independent read-only audits were completed and reconciled into these gates.
- [x] The signer/live-connection correctness blockers in this roadmap are fixed
      ([PR #188](https://github.com/synadia-ai/synadia-agents/pull/188)).
- [ ] The optional tracing feature is merged and its release gate is complete.
- [ ] All intended SDK and integration artifacts are published through the recorded registry contract.
- [ ] Every provided integration and release-consuming example is assessed.
- [ ] Public repository and packed-artifact terminology audits pass.
- [ ] Every released artifact satisfies the normal dependency cooldown with no exception active.

## Recorded invariants

- Sender identity is optional. Identity-free callers and permissive hosts remain fully supported.
- The sender identity is the NATS user and account context authenticated on the connection; a
  separate application identity is not introduced by this rollout.
- Hosts remain permissive by default (`min_sender_trust=any` / `minSenderTrust: "any"`). Merely
  configuring a signer never enables signed-only admission.
- A configured signer mismatch fails loudly before signed send or registration and never silently
  downgrades.
- Missing discovery permission or non-NKEY authentication does not prevent explicitly
  identity-free operation.
- Tracing lands before these SDK versions are released and remains optional and wire-neutral when
  absent.
- The external dependency cooldown remains active except for a reviewed, scoped, expiring internal
  package mechanism.
- npm publication still requires the existing explicit per-command approval. For Python, deliberately
  pushing the version tag is the publication approval; no second approval screen is required.

## Immediate rollout setup

There are no deferred product decisions in this section. Complete the branch and CI items before
merging shared-branch feature work; complete the remaining operational items before publication.

- [x] Push `sdk-release-rollout` to GitHub and keep it until the final rollout merge. Branch
      protection is optional.
- [x] Add `sdk-release-rollout` to the `pull_request` base filters of all four Python CI workflows;
      the TypeScript PR workflows already cover every target branch.
- [x] Add `sdk-release-rollout` to the `push` filters of all relevant TypeScript and Python
      workflows so the merged branch result is revalidated.
- [x] Add CI and path-trigger coverage for Flue, Claude Code, and open-agent.
- [x] Add one aggregate CI summary covering caller SDKs, AgentService SDKs, cross-language
      tests, the identity workbook, DeerFlow, and every in-scope integration. Because component
      workflows are path-filtered, use an always-running evaluator rather than a naive pending
      fan-in over skipped jobs.
- Setup implementation and green component/aggregate evidence: [PR #186](https://github.com/synadia-ai/synadia-agents/pull/186).
- Every rollout PR uses a closed review loop: wait for Claude's review on the current head before
  making a follow-up commit, address every finding in that commit, comment
  `@claude please review my fixes`, and wait for the follow-up review before making another commit.
  Repeat until the latest head has no remaining findings; only then merge.
- These workflow changes live on the rollout branch. Once it is pushed, PRs targeting it use its
  base-branch workflows and pushes use the workflow files in the pushed commit; `main` need not
  receive them first.
- Recorded release-source fact: the
  [Python caller](../.github/workflows/release-python.yml),
  [Python AgentService](../.github/workflows/release-python-agent-service.yml), and
  [DeerFlow](../.github/workflows/release-python-deerflow.yml) workflows publish the tagged commit;
  the live `pypi` environment permits those tag prefixes without requiring `main`; npm publication
  is manual and has no branch restriction.
- [x] Adopt the documented [rollout exception](../CLAUDE.md#release-ladder-for-sdk-changes-that-examples-need):
      reviewed, clean release commits on the integration branch may be tagged/published,
      then the exact commits are reconciled into `main` after aging.
- [ ] Locate the real cooldown policy and record its exact duration, covered ecosystems,
      enforcement points, and package-specific exception syntax. Do not proceed to registry
      publication based on the assumed seven-day value. This is a pre-publication input, not a
      blocker for integration implementation, clean staging tooling, or local artifact rehearsal.
- [x] Complete the package/release DAG, including internal `file:` edges, published headless
      examples, external integrations, and private examples used as release evidence.
- [x] Replace dirty-tree or rebuild-on-publish flows with the clean, build-once artifact process in
      this roadmap.
- Release graph, freeze, artifact, and build-once workflow implementation:
  [PR #191](https://github.com/synadia-ai/synadia-agents/pull/191).
- No in-scope SDK, integration, example, or external gate may be omitted by an implementer. A scope
  change requires explicit user approval and a roadmap update.

## Resolved implementation contracts

### Caller identity default

Before this milestone, callers could start self-identity lookup during discovery when identity was
omitted, and their default header behavior differed. The common contract is:

| Configuration                                             | Discovery and request behavior                              |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| No identity option                                        | No identity lookup and no `Agent-Sender` header             |
| Explicit identity without signer, unsigned claim enabled  | Lookup and unsigned claim                                   |
| Explicit identity without signer, unsigned claim disabled | No identity lookup or header                                |
| Explicit identity with signer                             | Signed sender header after live-connection binding succeeds |

- [x] Make both languages implement the contract exactly.
- [x] At wire level, prove omission produces no `$SYS.REQ.USER.INFO`, no header, and no background
      identity work.
- [x] Test omission separately from an explicit empty identity option and
      `sendUnsignedClaim=false`; do not invent a second public “disabled identity” API.
- [x] Sweep TypeScript tests and examples that currently rely on the unreleased default unsigned
      claim and update them in the same change.
- [x] Update API documentation and changelogs to match the contract.

### AgentService identity default and privacy

Before this milestone, omitting host identity could still perform self-discovery and publish
unsigned user/account registration metadata. The release contract is:

- no host identity option means no self lookup and no own user/account/`id_sig` registration fields;
- optional incoming sender headers are still classified and exposed;
- default trust remains `any`, so headerless prompts remain accepted; and
- explicit host identity enables connection binding and identity registration.

- [x] Implement this contract in both languages.
- [x] Prove the identity-free/default startup path at wire level and without `$SYS` permission.
- [x] Keep inbound signed-only policy a separate, explicit opt-in.

### Connection-identity invariant and credential topology

**The sender identity is the NATS user and account context authenticated on that connection.** An
identity signer is not an independently selectable application identity.

Provided integrations expose one credential source, read once into an immutable snapshot that
supplies both the NATS authenticator and the identity signer. A low-level SDK caller may have to
supply signer material alongside an already-created `NatsConnection`, because the connection does
not expose its private seed; those two inputs must still represent the same NATS user and account
context.

- [x] Add shared TypeScript and Python connection-bundle helpers that resolve context or URL plus
      credentials once and return connection options plus an optional signer from the same
      snapshot. Identity-free mode remains the default; signed mode fails if the selected
      connection credentials cannot sign. The bundle owns cleanup after the connection closes.
- [x] Require every provided integration and release-consuming example to use those helpers; do not
      copy context, credentials, seed, authenticator, or signer resolution into integrations.
- [x] Remove or reject independently selectable connection and identity credentials in integration
      CLIs, environment variables, config files, and plugin settings.
- [x] Require live-connection binding before every signed send or registration path can become
      usable. If equality cannot be established, fail signed identity without affecting an
      explicitly identity-free path.
- [x] Never interpret an Alice-authenticated connection plus a Bob signer as Bob identity. Delegated
      identity, if ever designed, is a separate protocol feature outside this rollout.
- [ ] Test coordinated credential rotation without retaining or logging old credential material.

The 2026-09-01 branch audit found no integration or release-example code that directly loads a
context/creds/seed, constructs an authenticator, or derives a signer. The sole test-harness bypass
found in PI was replaced with one connection bundle. Lifecycle tests now distinguish retryable
connection owners, which retain the bundle until a successful close, from process-level runners
that expose no retry handle, which perform a best-effort close and then guarantee the bundle is
wiped.

### Registry release contract

There is no registry-independent “dark release” mechanism. This rollout uses the following fixed
contract:

- npm final versions are published under `next`. Our rollout manifests use exact versions and
  frozen locks. A dist-tag is not treated as external semver quarantine.
- PyPI final versions are published early and publicly through the normal tag workflows, which also
  create GitHub Releases. Our rollout manifests use exact versions and frozen locks. We accept that
  unrelated external consumers with broad constraints are outside this rollout's control.
- The final upload time starts each artifact's cooldown clock. No package is rebuilt or republished
  at cutover.
- npm cutover moves the already-aged version's dist-tag. Python cutover adopts the already-public
  versions in normal locks and announces them; there is no PyPI promotion operation.
- ACP, Grok Build, Codex, OpenCode, Eve, and Flue are first npm publishes. Publishing them under
  `next` intentionally leaves no `latest`; bare installs fail until cutover. Existing npm packages
  keep their prior `latest` throughout aging. Claude Code ships through its marketplace instead of
  npm.

- [ ] Make every rollout manifest and lock select exact new internal versions while aging.
- [ ] If a quieter aging window is desired, manually delete only the generated GitHub Release entry
      after verifying PyPI publication. Keep the version tag and PyPI artifacts intact, and recreate
      the release entry from the same tag/digests at cutover if wanted.
- [ ] Publish each already-built, approved tarball with explicit
      `npm publish <approved.tgz> --tag next`; record pre/post dist-tags and digests. Never publish
      from a source directory that can rerun a lifecycle build.
- [ ] At cutover, add `latest` for first-publish packages and move it for existing packages; verify
      the exact digest in both cases.

### Replay and high-availability guarantee

Nonce caches are process-local, reset on restart, and can evict under pressure. Queue-group replicas
do not share replay state. For this release, replay protection is explicitly per-process and
best-effort. Shared HA replay storage is outside scope and strict sender policy does not imply
cross-replica or restart-persistent replay protection.

- [x] Document restart, eviction, and replica boundaries without overstating replay protection.
- [x] Test and observe the per-process cache behavior under concurrency and pressure.

## Workstream A: identity correctness and SDK behavior

### Signer/live-connection binding

A configured credentials signer must not be trusted merely because its own JWT matches its own
key. The SDK must establish that the signer represents the user authenticated on the live
connection.

- [x] Fix credentials-based signer validation in TypeScript and Python; an Alice connection with
      Bob credentials must fail before sending or registering a signed identity.
- [x] Fix TypeScript identity caching so a prior lookup cannot bypass a later signer's validation;
      key it by connection plus identity-source fingerprint and retain reconnect invalidation.
- [x] Do not retain Python identity results across identity-bearing operations: an externally
      supplied nats-py connection exposes no reconnect epoch to the SDK. Revalidate the live
      connection/signer binding for each signed send or registration until reliable invalidation is
      available.
- [x] Derive connection and signer inputs from one immutable credential snapshot in integrations;
      redact all credential material.
- [ ] Test seed, credentials, context, same-user/different-account JWTs, mismatched credentials,
      multiple clients/services sharing one connection, reconnect, and credential rotation.
- [x] A configured signer mismatch is a typed/actionable error in both languages and never silently
      downgrades to unsigned or headerless operation.

### Caller SDKs

- [x] TypeScript and Python caller unit and integration identity suites pass.
- [x] Direct TypeScript-caller to Python-host and Python-caller to TypeScript-host tests cover
      signed, unsigned, and headerless prompts.
- [x] Discovery treats a service without `min_sender_trust` as legacy-compatible.
- [x] A permissive target remains callable when identity discovery is unavailable.
- [ ] A strict target without a configured signer fails with an inspectable error code and
      description in both languages, not only a parsed message string.
- [x] Signed payload sizing includes all NATS header framing and remains under broker limits.
- [x] Unknown and duplicate identity headers fail according to the documented policy.
- [x] Intended public identity types and helpers are exported from documented package paths.
- [ ] Identity crypto libraries remain normal SDK dependencies for this release; prove that an
      identity-free import/start path works in every supported runtime without configuration.

### AgentService SDKs

- [x] TypeScript and Python AgentService identity suites pass.
- [x] Default trust remains `any` in code, tests, examples, and docs.
- [x] Headerless prompts are accepted by default; valid signed prompts expose a signature-valid
      sender to the handler.
- [x] Invalid signature, timestamp, subject, and replay checks apply to prompt admission before
      acknowledgement or handler execution.
- [x] Status/liveness requests remain compatible and classify identity without being rejected for
      malformed, stale, or replayed identity.
- [x] Registration without a usable connection identity follows the recorded host-default contract.
- [x] A configured host signer registers a verifiable `id_sig` only after connection binding.
- [ ] Raw nonces, seeds, credentials, signatures, JWTs, and authentication headers never appear in
      structured or rendered logs, rejection details, or exceptions. Add explicit redaction tests.
- [ ] Service imports, account-token placement, `sub` overrides, renamed/closed exports, request-info
      stamps, and operator-attested behavior are exercised or the unsupported capability is removed.

### Security vocabulary and protocol boundaries

- [x] Use **signature-valid sender** for proof of key possession. Treat `account` as claimed unless
      `accountAttested`/the equivalent operator-backed result is true.
- [x] Do not imply that an `id_sig` alone proves account membership.
- [x] Document that only the initial prompt is signed: prompt responses and midstream query replies
      are not independently authenticated.
- [x] Never infer a query respondent, approval actor, or logical session from the original prompt
      sender or a trace context.
- [x] Reverse identity lookup that returns one of several sessions sharing a key is not an
      authorization primitive and must not be used to attribute a specific session.

## Workstream B: optional tracing release gate

The SDK versions in this rollout depend on the separately developed optional tracing change. Its
public wording must remain product-neutral.

- Implementation owner: trace SDK owner (`@cozis`)
- PR and reviewed merge SHA: _not yet recorded_
- Fallback: none for this release. If tracing is delayed, the coordinated SDK release waits.

- [ ] Open a reviewed feature PR targeting `sdk-release-rollout`; do not push the implementation
      directly to the shared branch.
- [ ] Define exactly which caller/host packages, languages, runtimes, public APIs, propagation
      format, and exporters are in scope.
- [ ] Keep exporter libraries optional: no eager mandatory import, network connection, background
      worker, or global provider mutation when tracing is unconfigured.
- [ ] Prove that the unconfigured state is byte-for-byte wire-neutral, including no ambient
      global-context propagation.
- [ ] Budget `Agent-Sender`, trace headers, baggage, and NATS framing together before publish.
- [ ] Never add headers to the protocol's mandatory empty, headerless terminator.
- [ ] Test the leading acknowledgement, every response/error path, early iterator abandonment,
      cancellation, timeout, reconnect, shutdown flush, exporter recursion, and concurrent context
      isolation.
- [ ] A caller/session may not shut down a shared/global provider or double-register processors.
- [ ] Export failure, retry, backpressure, sampling, cardinality, and shutdown bounds never break or
      indefinitely delay the prompt stream.
- [ ] Treat incoming trace IDs and baggage as untrusted, bounded input. Trace headers are outside
      the sender signature and never affect authentication or authorization.
- [ ] Do not automatically use ambiguous sender reverse-resolution to enrich trace identity.
- [ ] Default redaction covers prompt/response/tool/query/status content, attachment names/content,
      subjects and session tokens, user/account/name, identity and request-info headers, baggage,
      exporter authorization, NATS credentials, nonces, signatures, JWTs, and exception causes.
- [ ] Raw-content capture, if supported, is a distinct opt-in with tenant-safe sampling, retention,
      and cardinality limits.
- [ ] Test identity off/tracing off, identity on/tracing off, identity off/tracing on, and identity
      on/tracing on. Traces without identity must not invent a verified sender.
- [ ] Test supported Node, Bun, browser/edge, and Python 3.11-3.13 consumers as applicable.
- [ ] Review and freeze every new dependency; no incidental refresh is allowed.
- [ ] Add public-safe usage docs and changelogs, then run all caller, host, cross-language, package,
      and integration gates after merge.

## Workstream C: public documentation and package content

Teach neutral concepts such as **sender identity**, **signed sender**, `Agent-Sender`,
**signature-valid**, and **account-attested**.

- [x] Teach the identity-free caller first in both caller READMEs.
- [x] Teach explicit unsigned and signed caller setup in both caller READMEs.
- [x] Explain strict targets, signer/connection binding, and safe credential handling.
- [x] Teach optional `stream.sender` / `response.sender` handling in both AgentService READMEs.
- [x] Explain permissive defaults, explicit signed-only mode, replay scope, unsigned
      response/query boundaries, and account-attestation semantics.
- [x] Ensure protocol-mapping documents are self-contained or link only to approved public specs.
- [ ] Audit the **entire public repository**, generated docs, source maps, changelogs, release notes,
      package metadata, fixtures, and source docstrings for private terminology and links.
- [ ] Reconcile stale integration documentation with the capabilities actually shipped by
      `AgentService`, including extension-endpoint support used by headless controllers.
- [ ] Inspect npm tarballs and both Python wheels **and sdists**, not only the source tree.
- [ ] Fail closed with package-content allowlists and scan artifacts for credentials, seeds, tokens,
      private links, source paths, and unintended files.
- [ ] Record a zero-hit terminology result and reviewed artifact manifests here or in the relevant
      pull request.

## Workstream D: integration compatibility and inventory

Every shipped integration must support both modes from the same released version:

- **Identity-free:** existing NATS configuration suffices; no signer setting is required; default
  hosts accept headerless prompts; startup and prompting work without identity-discovery permission.
- **Identity-enabled:** signer configuration is explicit and connection-bound; registration can
  include `id_sig`; outgoing SDK prompts use the configured connection identity; inbound sender
  metadata is exposed without automatic insertion into model prompts; strict policy is separate.

### Publishable and external integrations

| Integration/artifact | Shape | Release classification | Required work | Status |
| --- | --- | --- | --- | --- |
| ACP | `AgentService` | npm, first publish | signer/trust plumbing; exact SDK; lock/artifact smoke | [ ] |
| Grok Build | ACP front door | npm, first publish | inherit ACP; include Grok-to-ACP dependency edge | [ ] |
| Codex | `AgentService`, manager | npm, first publish | signer/trust; document shared connection identity | [ ] |
| OpenCode | `AgentService` | npm, first publish | signer/trust; installed-plugin path | [ ] |
| Eve | `AgentService` | npm, first publish | signer/trust; lock/artifact smoke | [ ] |
| Flue | `AgentService` | npm, first publish | signer/trust; add missing CI coverage | [ ] |
| DeerFlow | Python `AgentService` | PyPI, existing | signer/trust; SDK-triggered CI; lock/artifact smoke | [ ] |
| OpenClaw | `AgentService` channel | npm, existing | validate completed migration; add release lock; exact SDK refs; artifact smoke | [ ] |
| PI | `AgentService` extension | npm, existing | validate completed migration and deferred prompt lifecycle; add release lock; exact SDK refs | [ ] |
| Claude Code channel | bundled `AgentService` runtime | marketplace package manifest | validate completed migration; exact SDK/lock; verify committed runtime; marketplace install | [ ] |
| Claude Code plugin descriptor | marketplace metadata | versioned marketplace | sync `plugin.json` with package manifest; smoke marketplace install | [ ] |
| PI headless controller | multi-session host | npm, existing | shared identity docs; exact dependencies; artifact smoke | [ ] |
| Claude Code headless controller | multi-session host | npm, existing | shared identity docs; remove `latest`; artifact smoke | [ ] |
| Hermes (`synadia-ai/hermes-nats-gateway`) | external Python host | external gate | pin canonical repo/SHA; signer plumbing; artifact evidence | [ ] |

The prior Claude Code descriptor mismatch is corrected: the branch package manifest and plugin
descriptor both currently read `0.5.1`. Because the marketplace contents have changed, release
preparation must choose a new unique version, update both files together, rebuild/verify the
committed runtime, and validate the marketplace installation path. Equality at the branch version
does not complete those release gates.

### Private/source release consumers

Private packages still provide compatibility evidence and must install packed/registry artifacts,
not monorepo source shortcuts.

| Consumer | Primary role | Status |
| --- | --- | --- |
| open-agent | AgentService integration | [ ] |
| open-agent-vercel | host/example | [ ] |
| DSPy | TypeScript/Bun host/example | [ ] |
| DSPy research agent | TypeScript/Bun host/example | [ ] |
| Durable agents | host/example | [ ] |
| Agent web UI | caller-facing application | [ ] |
| Python identity workbook | cross-agent/caller acceptance | [ ] |
| Reference agents and ladders | protocol examples | [ ] |

For every applicable inventory row:

- [ ] Record identity-free startup/prompt and signed registration/inbound-prompt evidence.
- [ ] Record prompt rejection before ack/handler for invalid identity, without secret-bearing logs.
- [ ] Verify no identity configuration remains a valid, documented configuration.
- [x] Plumb signer/trust settings from an immutable connection credential snapshot where supported.
- [ ] Cover both CLI and installed-plugin/runtime paths.
- [ ] Test real runtime behavior and clean artifact-only installation.
- [ ] Declare exact compatible internal versions; no monorepo `file:` or editable source counts as
      release proof.
- [ ] Record artifact SHA, environment, CI run, time, and reviewer for every applicable row.

Hand-rolled hosts require full service registration, prompt admission before acknowledgement,
status classification, replay behavior, sender exposure, logging/redaction, and error semantics.
Adding only a signature gate is not sufficient. Where `AgentService` supports the needed extension
endpoints, prefer migration over duplicating protocol security behavior.

OpenClaw and PI do **not** currently declare `bundleDependencies`; their npm tarballs do not embed
SDK `node_modules` bytes. Treat them as ordinary SDK dependencies, correct the stale bundled-package
release comment, add immutable locks, and verify that no `file:` reference reaches either tarball.
Their clean-install smoke must import and execute both SDK dependencies; local-link tests previously
failed to catch a published missing-module regression caused by an invalid bundling declaration.
If bundling is introduced later, it requires an explicit artifact and age-clock review.

### Multi-session identity contract

One NATS connection has one cryptographic user identity. Logical sessions sharing a connection
therefore share that identity, and reverse lookup cannot prove which session acted. For this
rollout, Codex and the PI/Claude headless controllers keep their shared connection: their sessions
are logical agent instances under one connection identity, not independent cryptographic agents.
No per-session credential or connection setting is added.

- [ ] Inventory Codex, PI/Claude headless controllers, and all other shared-connection managers.
- [ ] Document the shared-identity model without treating names, subjects, trace IDs, or first-match
      reverse lookup as cryptographic session identity.
- [ ] Correct descriptions that call each logical session an independently identified agent.
- [ ] Treat independently credentialed per-session identities as a future explicit architecture,
      not part of this release.

### Two-stage SDK consumption by integrations

Integration development and registry aging are separate stages:

1. **Branch-development stage:** integrations in this repository consume the SDKs from the
   integration-branch workspace/local sources. External repositories consume exact SDK tarballs or
   wheels produced by CI from a recorded branch commit. This enables implementation before registry
   packages exist, but it is not release proof and must not leak local-source dependencies into a
   published manifest.
2. **Registry-aging stage:** after the SDK APIs and package contents are frozen, build the SDK
   artifacts once from a clean reviewed branch commit and test those exact tarballs/wheels. Publish
   the approved candidate bytes in dependency order. Then replace local SDK references in
   integration release manifests and locks with exact registry versions, using the scoped cooldown
   mechanism only for the fresh internal packages. Build, test, and publish integration candidates
   against those registry SDKs.

At cutover, do not rebuild or republish. After every final artifact has aged, remove the cooldown
exception, repeat immutable registry installs, reconcile the exact release commits into `main`,
move the recorded npm dist-tags, and perform the recorded Python adoption/announcement step.
Any artifact-byte change requires a new version and age clock.

- [ ] Branch-development CI proves all integrations compile and run against the coordinated SDK
      source commit before candidates exist.
- [x] Artifact-rehearsal CI proves the same integrations against the exact locally packed SDK bytes.
- [ ] Registry-aging CI proves integrations against exact registry SDK versions with no local,
      workspace, Git, or editable-source fallback.
- [ ] Link the source commit, local artifact digests, registry digests, and integration locks here or
      in the relevant pull request so equivalence across all three stages is auditable.

## Workstream E: dependency freeze and cooldown

### Freeze the complete graph

- [x] Inventory every deployable manifest, lock, platform, architecture, release action, build tool,
      and internal dependency edge. Include Grok-to-ACP and the published headless packages.
- [ ] Classify packages without a committed lock as non-deployable or add and enforce a lock.
- [x] Remove or explicitly constrain mutable `latest`, `*`, empty peer ranges, unlocked installs,
      runtime installs, and local/editable sources from release proof.
- [ ] Generate the pre-release dependency inventory/SBOM with names, versions, hashes, licenses,
      and source registries.
- [x] Snapshot and freeze approved external packages and release/build inputs now.
- [ ] After tracing lands, review only intentional additions and record the final graph; reject
      unrelated updates.
- [ ] Pause dependency-update merges and preserve old locks/artifacts as rollback baseline.
- [x] Record dependency-bot configuration and ensure it cannot bypass the rollout freeze
      through a workflow or configuration outside the expected directory.
- [x] Relocate or delete `client-sdk/python/.github/dependabot.yml` and `CODEOWNERS`; GitHub ignores
      nested `.github` policy files, so there is currently no active dependency bot or ownership
      gate from those files.
- [ ] Define whether the freeze includes downstream deployment repositories and record their SHAs.

#### Release-manifest audit snapshot (2026-09-01)

This audit describes the active branch-development tree. Local SDK and editable Python references
are expected inputs at this stage, but none of the conditions below may appear in release proof or
published artifacts.

- OpenClaw and PI have no committed lock. Their local SDK cycle can hang Bun, so create and verify
  their immutable release locks only after staged manifests select exact registry SDK versions.
- PI headless has a stale lock root: its direct `@earendil-works/pi-ai` dependency is absent while
  an older transitive PI AI version remains resolved. Select a compatible exact version and refresh
  the release lock.
- ACP, Grok, Codex, OpenCode, Eve, Flue, and PI headless directly declare
  `@types/bun: "latest"`; the Eve CI job also selects `bun-version: latest`. Pin or explicitly
  approve them before freezing the graph. Current direct manifests have no empty or `*` peer
  ranges: OpenClaw now uses `openclaw >=2026.5.4 <2027`, and PI uses
  `@earendil-works/pi-coding-agent >=0.84.0 <0.85.0`.
- Eve, Flue, OpenClaw, PI, Claude Code, and both published headless packages have local TypeScript
  SDK refs; Grok has a local ACP ref. ACP, Codex, and OpenCode still select the previously published
  SDK through broad `^0.5.2` ranges. Release staging must replace every internal edge with the exact
  candidate version and regenerate the corresponding lock.
- DeerFlow's branch lock correctly resolves the two local Python SDKs as editable sources, but its
  staged release inputs must remove `[tool.uv.sources]`, select exact registry SDK versions, and run
  with `uv sync --locked`. Its unconstrained `hatchling` build requirement must also be frozen or
  supplied by an equivalently immutable build environment.
- Flue has no npm `files` allowlist and currently packs tests, `bun.lock`, and `tsconfig.json`.
  Several first-publish packages omit a package-local license, and OpenCode omits its changelog from
  the tarball. The artifact allowlist/license review must resolve or explicitly approve each shape.
- Current integration CI mixes behavioral and package evidence: PI, OpenClaw, and Claude Code pack
  manifests after absolute tarball-path rewrites; Eve and Flue inspect manifests containing local
  refs; ACP, Codex, and OpenCode test branch tarballs but inspect old registry ranges; Grok has no
  pack proof; the headless workflow now typechecks, tests, builds, and inspects local-source
  packages but still lacks artifact-only installation. These jobs remain useful branch-development
  evidence but cannot satisfy release-artifact gates.
- Current changed, already-published versions cannot be reused: the TypeScript SDK pair is still
  `0.5.2`, OpenClaw and PI are `0.5.6`, PI headless is `0.5.5`, Claude Code headless is `0.5.4`, and
  DeerFlow is `0.2.0`. The Claude marketplace pair is currently `0.5.1` and must move together.
  ACP, Grok, Codex, OpenCode, Eve, and Flue were absent from npm at audit time, but registry and tag
  uniqueness must be queried again immediately before versions are finalized.

- [x] Supersede the misleading package checks above with clean staged-manifest validation and
      artifact-only installation of the exact packed bytes.
- [ ] Close every missing/stale-lock, mutable-direct-input, artifact-allowlist, and version-collision
      item from this snapshot before registry publication.

### Cooldown exception

The measured policy and its enforcing configuration are required before this exception is enabled
or any candidate is uploaded. Their absence does not pause branch implementation or exact local
artifact rehearsal.

Preferred approach:

- [ ] Keep the cooldown active for external packages.
- [ ] Exclude only the exact new internal packages using the enforcing tool's scoped mechanism.
- [ ] Record start, expiry, removal change, and CI proof that external versions are unchanged.

Fallback, only if a scoped mechanism is unavailable:

- [ ] Approve a narrow, time-boxed exception limited to lock generation and immutable installation.
- [ ] Require a reviewed zero-external-change dependency diff before and after every such install.
- [ ] Restore enforcement before any ordinary update or unlocked install can run.

### Immutable installation

- [ ] Bun uses committed locks and `bun install --frozen-lockfile`/the approved immutable equivalent.
- [ ] uv uses committed locks and `uv sync --locked`.
- [ ] npm packages are tested from exact packed tarballs without workspace/file resolution.
- [ ] Python packages are tested from exact wheel and sdist artifacts without editable/source
      overrides.
- [ ] Registry integrity hashes are verified; builds/tests cannot rewrite locks; CI rejects drift.

## Workstream F: clean artifacts, release DAG, and provenance

### Build and validate once

- [x] Replace `devtools/devmode.sh off` with a deterministic staging-directory release transform
      that covers every TypeScript internal edge, emits exact versions, and never mutates the source
      tree. The current tree is already mixed between local and registry specifications.
- [x] Add the equivalent Python staging flow: remove `[tool.uv.sources]`/editable overrides only in
      staged release inputs, resolve exact registry SDK versions, and produce immutable locks for
      DeerFlow, the identity workbook, and every other Python consumer.
- [x] Make one graph validator cover both ecosystems and fail on any release artifact containing a
      `file:`, workspace, Git, path, editable, missing-lock, `latest`, empty, or wildcard internal
      dependency that is not explicitly allowed.
- [ ] Create the release/version changes as a clean, reviewed commit. Do not publish from manifests
      transiently rewritten by a developer helper.
- [ ] Validate the complete package graph so no runtime `file:`, workspace-only, editable, or stale
      internal constraint can escape.
- [x] Build/pack once from the recorded commit, hash the artifacts, and hand the same bytes through
      package inspection, tests, approval, and publication. A publish job must not rebuild them.
- [x] Install and run all relevant tests from those artifacts in clean environments with no source
      tree resolution.
- [ ] Produce reviewed package manifests, SBOMs, checksums, and registry-supported provenance or
      attestations. Record any platform that cannot supply the expected provenance.
- [x] Pin or otherwise approve mutable release infrastructure and verify downloaded tools by
      checksum/signature.
- [ ] Verify npm publisher identity, 2FA/automation policy, access level, provenance support, and
      the explicit non-default publish tag.
- [ ] Verify PyPI trusted-publisher environment/tag rules and require publication approval.
- [ ] Record whether each Python GitHub Release remains visible during aging or is manually deleted;
      never delete the source tag as part of quieting the release.

### Version and dependency DAG

- [ ] Record current registry versions, immutable digests, npm dist-tags, Python yanked state, and
      repository tags before choosing new versions.
- [ ] Confirm every proposed version and tag is unique and has not already been published.
- [ ] Bump every changed, already-published package and update its public changelog/release notes.
- [ ] Define the per-language topological publish order, canary, stop point, and reverse rollback
      order. Include integration-to-integration edges, not only SDK edges.
- [ ] Prove rollout-owned manifests and locks select only the recorded exact internal versions in
      both npm and Python environments.
- [ ] Any artifact-affecting fix after publication gets a new version and restarts its age clock.
      Define the narrow docs/metadata-only exception, if any.
- [ ] Freeze each published artifact's source SHA; merging a conflicting `main` change requires
      reconciliation, repeat evidence, and—if bytes change—a new artifact/version.

## Compatibility acceptance matrix

Run applicable rows in both language directions and against exact release artifacts.

| Endpoint/configuration | Expected outcome | Proof |
| --- | --- | --- |
| Legacy/headerless caller -> new default prompt endpoint | accepted; sender absent | [ ] |
| New caller with identity omitted -> legacy agent | no lookup/header; accepted | [ ] |
| New caller with identity omitted -> new default agent | no lookup/header; accepted | [ ] |
| Explicit unsigned claim -> new default prompt endpoint | accepted as claimed, never signature-valid | [ ] |
| Signed caller -> new default prompt endpoint | accepted as signature-valid | [ ] |
| Signed caller -> signed-only prompt endpoint | accepted as signature-valid | [ ] |
| Headerless/unsigned -> signed-only prompt endpoint | typed/actionable rejection | [ ] |
| Invalid/replayed/stale identity -> prompt endpoint | rejected before ack/handler | [ ] |
| Invalid/replayed/stale identity -> status endpoint | classified but status remains compatible | [ ] |
| Password/token connection -> new default agent | identity-free operation | [ ] |
| NKEY without discovery permission -> default agent | approved identity-free behavior | [ ] |
| Explicit mismatched seed/credentials signer | clear failure; no signed send/register or downgrade | [ ] |
| Second signer/client on cached shared connection | independently validated; no cached bypass | [ ] |
| TypeScript reconnect/credential rotation | signer-keyed cache invalidates and rebinds | [ ] |
| Python reconnect/credential rotation | no stale settled identity; next identity-bearing operation revalidates | [ ] |
| Signature-valid sender without operator attestation | user valid; account remains claimed/unattested | [ ] |
| Matching operator-attested sender | user valid and `accountAttested=true` | [ ] |
| Operator-attested user/account mismatch | prompt rejected before ack/handler | [ ] |
| New caller -> old extension-ignoring agent | prompt/stream compatibility | [ ] |
| Midstream query/reply | documented as unsigned; no inherited sender authorization | [ ] |
| Trace context plus identity | trace is untrusted; combined headers bounded; auth unchanged | [ ] |
| No trace configuration | byte-for-byte legacy wire behavior | [ ] |

Additional parser and concurrency coverage includes unknown/duplicate headers, concurrent sessions,
multi-instance replay boundaries, service import/account-token cases, malicious trace/baggage input,
stream cancellation, and mixed TypeScript/Python clients and hosts.

## Staged release runbook

### Before publication

- [ ] Every resolved implementation contract and rollout prerequisite is complete.
- [ ] Identity correctness fixes and tracing have merged with all required checks.
- [ ] Full inventory scope, release DAG, versions, constraints, artifact hashes, and
      rollback baseline are approved.
- [ ] Full-repository and exact-artifact terminology/content audits pass.
- [ ] Cooldown baseline and temporary exception mechanics are proven in CI.
- [ ] Every rollout-owned consumer selects the intended exact internal versions and frozen locks.
- [ ] A human gives the separately required publication approval for each registry/ecosystem.

### Publish final versions according to the recorded registry contract

- [ ] Publish in the recorded dependency order from the approved, already-tested bytes.
- [ ] Record package/version, source SHA, artifact digest, registry digest, tag/index, publisher,
      approval, upload time, and provenance for each artifact.
- [ ] Stop immediately on a partial failure; assess dependents before resuming. Never reuse a version
      whose bytes reached a registry.
- [ ] Verify metadata and clean installs from the registry without source/editable overrides.
- [ ] Start an independent age clock for every final artifact that must satisfy cooldown.

### Exercise during aging

- [ ] Resolve only the approved new internal artifacts through the temporary scoped mechanism.
- [ ] Prove external dependency versions and hashes remain identical to the frozen baseline.
- [ ] Run full SDK, cross-language, integration, real-runtime, artifact-only, upgrade, rollback, and
      identity workbook suites on the explicitly approved OS/architecture/runtime matrix.
- [ ] Record every result with source SHA, artifact hashes, CI run, environment, time, and reviewer.
- [ ] Classify defects as artifact-affecting or evidence-only; issue new versions and restart age
      clocks whenever bytes change.

### Exit the aging window

- [ ] Confirm every final selected artifact has reached the measured policy age.
- [ ] Remove temporary exceptions **before** unfreezing dependency updates.
- [ ] Run clean registry installs under normal cooldown and immutable-install flags.
- [ ] Re-run the release acceptance subset and verify no external graph drift.
- [ ] Reconcile the exact tagged release commits from the rollout branch into `main`; any
      artifact-affecting difference requires a new version and age clock.
- [ ] Move npm dist-tags only after verifying exact digests; adopt and announce the already-public
      Python versions with no additional PyPI registry operation.
- [ ] Resume dependency automation only after normal enforcement is verified active.
- [ ] Announce availability and leave the completed roadmap and linked PR evidence on `main`.

## Rollback and incident response

Triggers include identity-free regression, signer/connection-binding failure, secret disclosure,
unexpected dependency change, provenance mismatch, partial publish/tag movement, trace data leak, or a
material integration failure.

- [ ] Stop publication, tag movement, deployment, and announcements; record the incident.
- [ ] Restore prior npm dist-tags by recorded digest and previous manifests/locks in reverse
      dependency order.
- [ ] For a failed first-publish npm package, remove or redirect only its `next` tag and deprecate the
      bad version as appropriate; there is no prior `latest` or artifact to restore.
- [ ] For Python, apply the pre-approved yank/constraint/rollback plan, recognizing that yanks do
      not remove files and exact pins may still install them.
- [ ] Correct or mark affected repository releases and disable compromised publisher credentials or
      environments when applicable.
- [ ] Redeploy preserved previous artifacts and remove rollout cooldown exceptions if abandoned.
- [ ] Never overwrite or republish a version; fix forward with a new version and age clock.
- [ ] Communicate affected versions, exposure, mitigation, and safe versions.
- [ ] Retain failure evidence, artifact hashes, logs with secrets removed, and required retests.

## Evidence

The roadmap itself is the persistent record; no separate release ticket is required. Checkboxes may
link to the relevant PR or CI run instead of duplicating details here. For publication-sensitive
steps, retain the source commit, package/version, artifact digest, registry time, dependency diff,
and rollback baseline. A green test against local workspace sources is not registry-artifact proof.

## Post-rollout steady state

- The source tree keeps local development links/uv sources where useful.
- Release tooling creates clean staging directories with exact internal versions; it does not flip
  the working tree between modes.
- Published integrations keep exact SDK dependencies until a deliberate integration release
  upgrades them. Returning to broad ranges is not part of cutover.
- The same cross-ecosystem graph validator, artifact-only tests, locks, and normal cooldown remain
  required for later releases.
- After completion, the roadmap and linked PR evidence remain on `main` as the durable history; the
  integration branch may then be deleted.

## Completion definition

The rollout is complete only when:

- all intended SDK and integration artifacts are available through their normal channels;
- the normal dependency cooldown is active with no rollout exception;
- all applicable compatibility rows have durable artifact-based evidence;
- every in-scope integration and release consumer is complete;
- public caller and AgentService docs teach identity-free and signed operation using approved terms;
- tracing is optional, privacy-reviewed, and wire-neutral when absent;
- registry/source/provenance records and tested rollback paths are archived; and
- no unresolved release blocker remains in this roadmap or its linked pull requests.
