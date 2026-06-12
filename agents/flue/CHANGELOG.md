# Changelog

All notable changes to `@synadia-ai/flue-nats-channel` will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Fleet-wide identity fallbacks per the `SYNADIA_*` convention shared
  across `agents/*`: `SYNADIA_OWNER` and `SYNADIA_NAME` are honored
  below the per-agent `SYNADIA_FLUE_OWNER` / `SYNADIA_FLUE_NAME` and
  above the TOML config. Purely additive.

## [0.1.0] and earlier

Changelog started 2026-06-12 (at package version 0.1.0); see the git
history of `agents/flue/` for earlier changes.
