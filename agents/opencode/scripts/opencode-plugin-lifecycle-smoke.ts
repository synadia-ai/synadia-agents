#!/usr/bin/env bun
// Maintained entrypoint for the plugin lifecycle smoke. This wraps the proven
// spike harness until the real OpenCode server smoke is run in CI/PR review.
await import("../spikes/plugin-channel/scripts/run-plugin-lifecycle-permission-gate.js");
