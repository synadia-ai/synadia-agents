#!/usr/bin/env bun
// Maintained entrypoint for the plugin permission bridge smoke. The underlying
// harness exercises OpenCode plugin load, duplicate init, permission ask/reply,
// process-death discovery expiry, and restart idempotency against real NATS.
await import("../spikes/plugin-channel/scripts/run-plugin-lifecycle-permission-gate.js");
