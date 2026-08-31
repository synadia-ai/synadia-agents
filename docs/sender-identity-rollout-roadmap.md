# Sender identity rollout roadmap

- Status: active
- Last updated: 2026-08-31
- Scope: TypeScript and Python caller/host SDKs, provided agent integrations, and release operations

This document is the persistent source of truth for taking sender identity from the merged SDK
implementation to a safe, backwards-compatible release. Check an item only when its evidence is
linked here or in the relevant pull request. A separate tracking issue may mirror operational
status, but it does not replace this roadmap.

The rollout has four non-negotiable outcomes:

1. Existing agents and callers continue to work without sender identity.
2. Configured agents can register and send with a verified identity.
3. The dependency-cooldown control remains effective for external packages during the accelerated
   release.
4. Public SDK documentation teaches sender identity without unreleased product names, private
   roadmap language, or links to non-public specifications.

## Workflow terminology

- **Rollout branch:** `sender-identity-rollout`, the integration branch on which this roadmap and
  the coordinated SDK/integration changes are assembled and exercised.
- **SDK release PR:** a reviewed change that finalizes versions, dependency constraints,
  changelogs, and package contents for one or both SDK halves. Merging it prepares a release; it
  does not by itself authorize or perform an npm publication.
- **Integration PR:** a reviewed change for one or more provided agents, normally targeting the
  rollout branch during this effort. It adds optional identity configuration, compatibility tests,
  and registry dependency/lock updates for those agents.
- **Rollout PR:** the final pull request from `sender-identity-rollout` to `main`, opened after the
  dark artifacts have passed the required checks and aging window.
- **Rollout tracking issue:** an optional GitHub issue or project item for facts that do not live
  naturally in Git, such as publication approvals, artifact upload times, exception expiry, and
  deployment observations. If none is created, those facts and their evidence links must be added
  directly to this roadmap.

## Current state

- [x] Sender-identity implementation is merged into both SDK pairs.
- [x] The Python [identity workbook](../examples/identity-workbook/python/README.md) demonstrates
      signed Echo, signed Hello-to-Echo forwarding, and identity-free calls.
- [ ] SDK packages containing sender identity are published to npm and PyPI.
- [ ] Every provided integration has been assessed and adapted where necessary.
- [ ] Public SDK documentation has passed the terminology/link audit.
- [ ] Dark releases have aged through the dependency cooldown and been promoted.

## Recorded rollout decisions

- Sender identity is an optional protocol capability, not a requirement for using the SDKs.
- Agent hosts remain permissive by default (`min_sender_trust=any` / `minSenderTrust: "any"`).
- Signed-only operation is an explicit operator choice and is never enabled merely because a
  signer is available.
- Missing identity, missing identity-discovery permissions, and non-NKEY authentication must not
  prevent a permissive agent from starting or serving legacy requests.
- A signer that is explicitly configured but does not match the connection identity fails loudly;
  it must not silently downgrade.
- The signer/credential source is explicit. Seeds, credentials, nonces, and raw signatures are
  never logged.
- Work proceeds on a dedicated rollout branch. Registry artifacts are published dark so their age
  clocks run while the branch is exercised.
- External dependencies are frozen. Prefer package-specific cooldown exceptions for newly released
  Synadia packages; disabling the cooldown globally is a time-boxed fallback only.
- npm candidates use a non-default dist-tag such as `next`. PyPI candidates use their final version
  but remain unannounced and unselected by production locks until promotion.
- npm publication remains a separately approved operation for each package. This checklist does
  not itself authorize a publish.

## Decision gate: caller defaults

TypeScript and Python currently differ when no caller identity option is supplied. Resolve this
before cutting the SDK releases.

Proposed common contract:

| Configuration | Request behaviour |
| --- | --- |
| No identity option | No identity lookup and no `Agent-Sender` header |
| Explicit identity option without a signer | Unsigned claim, unless disabled by its option |
| Explicit identity option with a signer | Signed sender header |

- [ ] Approve or amend this contract.
- [ ] Make TypeScript and Python behavior identical.
- [ ] Test that the identity-free path does not perform `$SYS.REQ.USER.INFO` work.
- [ ] Update API documentation and changelogs to match the chosen behavior.

## Workstream A: SDK release readiness

### Caller SDKs

- [ ] TypeScript caller passes unit and integration identity suites.
- [ ] Python caller passes unit and integration identity suites.
- [ ] Cross-language tests cover signed, unsigned, and headerless requests.
- [ ] Discovery treats an agent without `min_sender_trust` as a legacy-compatible target.
- [ ] A permissive target remains callable when self-identity discovery is unavailable.
- [ ] A strict target without a configured signer fails with a clear, actionable error.
- [ ] Signed payload sizing includes header framing and remains below the broker limit.
- [ ] Identity types and helpers intended for users are exported from the documented package paths.

### AgentService SDKs

- [ ] TypeScript AgentService passes identity host integration tests.
- [ ] Python AgentService passes identity host integration tests.
- [ ] Default trust remains `any` in code, tests, examples, and documentation.
- [ ] A headerless prompt is accepted in the default mode.
- [ ] A valid signed prompt reaches the handler as a verified sender.
- [ ] Invalid signatures, stale timestamps, subject mismatches, and replayed nonces are rejected in
      every mode.
- [ ] A host without a usable connection identity still starts without identity registration
      metadata.
- [ ] A configured host signer registers a verifiable `id_sig`.
- [ ] Status/liveness behavior remains compatible with identity-free probes.
- [ ] The documentation states that prompt responses are not independently signed.

### Public documentation

The documentation should use neutral terms such as **sender identity**, **signed sender**,
`Agent-Sender`, and **verified registration**.

- [ ] Teach the identity-free caller first in both caller READMEs.
- [ ] Add the signed caller setup in both caller READMEs.
- [ ] Explain unsigned claims, verified senders, strict targets, and safe credential handling.
- [ ] Teach optional `stream.sender` / `response.sender` handling in both AgentService READMEs.
- [ ] Explain permissive-by-default and explicit signed-only operation.
- [ ] Ensure protocol-mapping documents are self-contained or link only to approved public specs.
- [ ] Remove unapproved sender-identity draft/spec links from:
  - `client-sdk/typescript/README.md`
  - `client-sdk/python/README.md`
  - `agent-sdk/typescript/README.md`
  - `agent-sdk/python/README.md`
  - the SDK protocol-mapping documents
  - SDK changelogs and public source docstrings
- [ ] Remove private roadmap or future-registry wording from public package content.
- [ ] Inspect packed npm tarballs and Python wheels, not only the source tree.
- [ ] Run the release owners' terminology audit and record a zero-hit result for public package
      contents here or in a linked pull request.

## Workstream B: integration compatibility

Every integration must support these two runtime configurations from the same released version:

**Identity-free**

- Existing NATS connection configuration is sufficient.
- No signer-specific setting is required.
- Incoming headerless prompts are accepted by default.
- Startup and normal prompting work when identity discovery is unavailable.

**Identity-enabled**

- An explicitly configured signer matches the NATS connection user.
- Host registration includes a verifiable identity signature.
- Outgoing SDK prompts, when the integration makes them, use the same connection identity and
  signer.
- Incoming sender trust is available to the integration without being inserted into the model
  prompt automatically.
- Strict inbound policy remains a separate opt-in setting.

### Integration inventory

| Integration | Current host shape | Required rollout work | Status |
| --- | --- | --- | --- |
| ACP | `AgentService` | Optional signer/trust configuration; dependency and lock update | [ ] |
| Grok Build | ACP front door | Verify it inherits ACP behavior; package/release smoke | [ ] |
| Codex | `AgentService`, including session manager | Optional signer; decide identity semantics for multiple sessions sharing a connection | [ ] |
| OpenCode | `AgentService` | Optional signer/trust configuration; installed-plugin dependency update | [ ] |
| Eve | `AgentService` | Optional signer/trust configuration; registry-artifact smoke | [ ] |
| Flue | `AgentService` | Optional signer/trust configuration; registry-artifact smoke | [ ] |
| open-agent | `AgentService` | Optional signer/trust configuration; registry-artifact smoke | [ ] |
| DeerFlow | Python `AgentService` | Optional signer/trust configuration; PyPI dependency and lock update | [ ] |
| Hermes | Python `AgentService` in its external repository | SDK version/lock update and optional signer plumbing in the external release | [ ] |
| Claude Code | Hand-rolled NATS microservice | Migrate to `AgentService` or add the equivalent sender gate before ack | [ ] |
| PI | Hand-rolled NATS microservice | Migrate to `AgentService` or add the equivalent sender gate before ack | [ ] |
| OpenClaw | Hand-rolled NATS microservice | Migrate to `AgentService` or add the equivalent sender gate before ack | [ ] |

For every row:

- [ ] Identity-free startup and prompt smoke recorded.
- [ ] Signed registration and signed inbound prompt smoke recorded.
- [ ] Invalid signature rejection recorded.
- [ ] No secret material appears in logs or errors.
- [ ] README documents optional identity configuration and strict-mode consequences.
- [ ] Published manifest declares an SDK version that contains the APIs it imports.
- [ ] Registry-artifact install is tested from a clean directory; monorepo `file:` links do not
      count as release proof.

### Multi-session identity decision

One NATS connection has one cryptographic user identity. Integrations that advertise multiple
logical agents on a shared connection therefore advertise the same identity for all of them.

- [ ] Inventory multi-session/shared-connection behavior in Codex, Claude Code headless, PI
      headless, and any manager/controller examples.
- [ ] Decide for each whether sessions are instances of one identity or independent agents.
- [ ] If independent, provision one NATS user and connection per session.
- [ ] Document the chosen model without implying that subject names are cryptographic identities.

## Workstream C: dependency freeze and accelerated release

### Establish the baseline

- [ ] Locate and record the actual cooldown configuration, owner, duration, and enforcement points.
- [ ] Inventory every deployable integration lockfile and every target OS/architecture represented
      by it.
- [ ] Generate the pre-release dependency inventory/SBOM.
- [ ] Commit the approved external dependency graph before resolving new internal packages.
- [ ] Pause automated dependency-update merges for the rollout window.
- [ ] Preserve the old manifests, locks, and deployable artifacts as the rollback baseline.

### Prepare the rollout branch

- [x] Create the local `sender-identity-rollout` branch and move the roadmap work onto it.
- [ ] Publish the rollout branch and apply the agreed remote review/protection rules.
- [ ] Require all normal CI and review checks on the branch.
- [ ] Keep it current with `main` so the eventual merge is low risk.
- [ ] Adapt integrations against local SDK sources while the registry packages are unavailable.
- [ ] Before release proof, replace local SDK sources with exact registry versions and refresh locks
      under the controlled policy.

### Cooldown exception

Preferred approach:

- [ ] Keep the global cooldown enabled for external packages.
- [ ] Add temporary package-specific exceptions only for the exact newly released Synadia SDK and
      integration package names.
- [ ] Record the exception owner, start time, expiry time, and removal PR/ticket.
- [ ] Fail CI if external package versions change in a release lockfile diff.

Fallback if the enforcing tool cannot express package-specific exceptions:

- [ ] Approve a narrowly scoped, time-boxed global exception.
- [ ] Permit it only in the lock-generation and locked-install jobs.
- [ ] Require immutable installs and a reviewed zero-external-change lock diff.
- [ ] Restore the cooldown before allowing any ordinary dependency update or unlocked install.

### Immutable installation requirements

- [ ] Bun deployments use committed `bun.lock` files and `bun ci` (or
      `bun install --frozen-lockfile`).
- [ ] uv deployments use committed `uv.lock` files and `uv sync --locked`.
- [ ] Registry integrity hashes are present for all downloaded artifacts.
- [ ] Build/test commands cannot rewrite locks.
- [ ] CI rejects a manifest/lock mismatch.

## Compatibility acceptance matrix

All applicable SDK pairs and integrations must demonstrate these outcomes:

| Caller | Receiver | Expected outcome | Proof |
| --- | --- | --- | --- |
| Legacy/headerless | New, default policy | Accepted; sender absent | [ ] |
| New, identity disabled | Legacy agent | Accepted | [ ] |
| New, identity disabled | New, default policy | Accepted; sender absent | [ ] |
| New, unsigned claim | New, default policy | Accepted as claimed, never authorized as verified | [ ] |
| New, signed | New, default policy | Accepted as verified | [ ] |
| New, signed | New, signed-only policy | Accepted as verified | [ ] |
| Headerless/unsigned | New, signed-only policy | Rejected with actionable authentication error | [ ] |
| Invalid/replayed/stale signature | New, either policy | Rejected | [ ] |
| Password/token connection | New, default policy | Normal identity-free operation | [ ] |
| NKEY connection without identity lookup permission | New, default policy | Normal operation without header | [ ] |
| Explicit mismatched signer | New SDK | Clear failure; no silent downgrade | [ ] |
| New caller | Old agent that ignores the extension | Prompt and streaming remain compatible | [ ] |

## Dark release runbook

### Before publishing

- [ ] All SDK decision gates and release-readiness checks above are complete.
- [ ] Integration candidates are complete on the rollout branch.
- [ ] Package versions and inter-package constraints are final.
- [ ] TypeScript integrations no longer rely on a previous `^0.x` range to cross an SDK minor
      boundary; each manifest explicitly accepts the new SDK version.
- [ ] Python integration constraints and locks select the intended new SDK versions.
- [ ] Changelogs use public-safe sender-identity terminology.
- [ ] Package contents have been inspected with the relevant pack/build command.
- [ ] The source commit for each artifact is immutable and recorded.

### Publish dark

- [ ] Publish the TypeScript caller SDK candidate.
- [ ] Publish the TypeScript AgentService candidate after its caller dependency is available.
- [ ] Publish the Python caller SDK through its approved tag workflow.
- [ ] Publish the Python AgentService SDK through its approved tag workflow.
- [ ] Verify registry metadata, integrity, and clean installation for all four SDK packages.
- [ ] Publish npm integration candidates under `next`, not `latest`.
- [ ] Publish final-but-unselected Python integration candidates where required.
- [ ] Record the upload time at which each artifact becomes cooldown-eligible.

### Exercise during aging

- [ ] Resolve only the new Synadia packages through the temporary exception.
- [ ] Confirm external dependency versions remain identical to the baseline.
- [ ] Run the full SDK CI matrix.
- [ ] Run every integration's normal protocol smoke and real-runtime smoke where available.
- [ ] Run the compatibility acceptance matrix.
- [ ] Run the Python identity workbook from a clean checkout.
- [ ] Test upgrade from the currently published integration version.
- [ ] Test rollback to the preserved old locks/artifacts.
- [ ] Track defects on this document or link their tickets next to the affected checkbox.

### Exit the aging window

Order matters:

- [ ] Confirm every selected artifact has reached the required age.
- [ ] Remove package-specific/global exceptions **before** unfreezing dependency updates.
- [ ] Run clean registry installs with the normal cooldown enabled and locked-install flags.
- [ ] Re-run the compatibility and integration smoke suites.
- [ ] Merge the rollout branch after required review.
- [ ] Promote the already-aged npm versions from `next` to `latest` without republishing them.
- [ ] Select the already-aged Python versions in production locks.
- [ ] Resume dependency automation only after the normal policy is verified active.
- [ ] Announce availability and archive release evidence.

## Rollback

Rollback is triggered by an identity-free compatibility regression, signer/connection mismatch that
is not diagnosed clearly, secret exposure, an unexpected external dependency change, an artifact
provenance mismatch, or a material integration failure.

- [ ] Stop promotion and deployment.
- [ ] Restore the previous manifests and committed locks.
- [ ] Redeploy the preserved previous artifacts.
- [ ] Remove temporary cooldown exceptions if the rollout is abandoned.
- [ ] Do not overwrite or republish a released version; fix forward with a new version.
- [ ] Record the failure, affected artifacts, and retest requirements before resuming.

## Completion definition

The rollout is complete only when:

- all four SDK packages and intended integration packages are available through their normal
  channels;
- the normal dependency cooldown is enabled with no rollout exception;
- every required compatibility-matrix row has recorded evidence;
- every integration row is complete or explicitly deferred with an owner and issue;
- public documentation teaches both identity-free and signed operation using approved terminology;
- and the preserved rollback baseline is no longer needed for the release window.
