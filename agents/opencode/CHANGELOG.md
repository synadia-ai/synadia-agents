# Changelog

All notable changes to `@synadia-ai/opencode-nats-channel` will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Fleet-wide identity fallbacks per the `SYNADIA_*` convention shared
  across `agents/*`: `SYNADIA_OWNER` and `SYNADIA_NAME` are honored in
  both CLI and plugin modes, below the per-agent vars and above the
  config file. Purely additive.
- `SYNADIA_OPENCODE_NAME` as the canonical spelling for the session
  (5th) subject token — the fleet convention uses the spec's `name`
  term. `SYNADIA_OPENCODE_SESSION` (and plugin-mode `SYNADIA_SESSION`)
  keep working as shipped aliases, one notch below.

## [0.1.0] and earlier

Changelog started 2026-06-12 (at package version 0.1.0); see the git
history of `agents/opencode/` for earlier changes.
