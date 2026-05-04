# Changelog

All notable changes to `@synadia-ai/nats-pi-headless` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
