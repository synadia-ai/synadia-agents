# Changelog

All notable changes to `@synadia-ai/nats-pi-headless` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] - 2026-05-04

### Fixed

- **Reject prompts to expired sessions.** `handlePrompt` now responds
  with `Nats-Service-Error-Code: 410 session expired` (plus the §6.5
  empty terminator) when the session's lifetime has run out but the
  manager's sweep loop hasn't disposed it yet. Previously, a prompt
  that arrived between expiry and the next sweep tick was served
  normally — the session accepted work it was about to drop. The
  session itself is unchanged; the guard only refuses new requests.
- **Reject prompts to disposed sessions with `503 session stopped`.**
  The pre-existing `disposed` short-circuit emitted only a §6.5
  terminator — indistinguishable on the wire from "stream completed
  cleanly with no chunks." Now sends an error header first so callers
  can tell "session was stopped" apart from "session ran and produced
  no output."

### Changed

- **Tighten the session-manager sweep cadence from 30 s to 2 s.**
  Combined with the `expired()` prompt guard, an expired session is
  disposed and unregistered from NATS within a couple of seconds of
  hitting its limit instead of up to 30 s.

## [0.5.1] - 2026-05-04

### Changed

- **Advertise the broker's negotiated `max_payload`** instead of a
  hardcoded `"1MB"`. The controller's prompt endpoint reads
  `nc.info.max_payload` directly (controllers register via `Svcm`,
  not the SDK class) and surfaces the live value (e.g. `"8MB"` on
  NGS) in `$SRV.INFO`. Spawned sessions get the same behavior for
  free now that `@synadia-ai/agent-service`'s `ReferenceAgent`
  defaults `max_payload` to `nc.info.max_payload` when no
  `maxPayload` option is passed. Matches the pattern already used by
  `agents/pi` and `agents/claude-code`.

## [0.5.0] - 2026-05-04

> **Breaking:** wire shape changes for the controller's extension
> endpoints (`spawn`, `stop`, `list`) and the agent token used by both
> the controller and its spawned sessions. Callers that hard-coded the
> old subjects need to update.

### Changed (breaking)

- **Verb-first throughout.** Extension endpoints move from
  `agents.<agent>.<owner>.<name>.<verb>` to
  `agents.<verb>.<agent>.<owner>.<name>`, matching the protocol's verb-
  first layout for `prompt` / `hb` / `status`. Net effect: any tracer
  or audit layer can subscribe to `agents.<verb>.>` and parse identity
  positionally for both protocol and extension traffic.
- **Agent token rename.** `metadata.agent` and the 3rd subject token
  flip from `pi` to `pi-headless` for both the controller and its
  spawned sessions. This separates the headless example from the
  standalone `agents/pi/` runtime (which keeps `pi`).
- **Metadata simplification.** `metadata.role = "pi-headless-controller"`
  becomes `metadata.role = "controller"`; sessions now carry
  `metadata.role = "session"`. The redundant `metadata.spawner` field
  is dropped — the `agent` token already disambiguates.
- **Default controller name** flips from `exec` to `control`. On
  startup the controller probes `$SRV.INFO.agents` and picks the next
  free `<name>-N` if its target prompt subject is already claimed, so
  two pi-headless processes booted with default settings yield
  `control` and `control-2` automatically.

### Subject migration

| from | to |
| --- | --- |
| `agents.prompt.pi.<owner>.<name>` | `agents.prompt.pi-headless.<owner>.<name>` |
| `agents.hb.pi.<owner>.<name>` | `agents.hb.pi-headless.<owner>.<name>` |
| `agents.status.pi.<owner>.<name>` | `agents.status.pi-headless.<owner>.<name>` |
| `agents.pi.<owner>.<name>.spawn` | `agents.spawn.pi-headless.<owner>.<name>` |
| `agents.pi.<owner>.<name>.stop` | `agents.stop.pi-headless.<owner>.<name>` |
| `agents.pi.<owner>.<name>.list` | `agents.list.pi-headless.<owner>.<name>` |
| `agents.prompt.pi.<owner>.<session_id>` | `agents.prompt.pi-headless.<owner>.<session_id>` |
| `agents.hb.pi.<owner>.<session_id>` | `agents.hb.pi-headless.<owner>.<session_id>` |
| `agents.status.pi.<owner>.<session_id>` | `agents.status.pi-headless.<owner>.<session_id>` |

### SDK

Bumps `@synadia-ai/agents` and `@synadia-ai/agent-service` pins to
`^0.5.0`.
