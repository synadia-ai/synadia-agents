#!/usr/bin/env bun
// Maintained production plugin permission smoke. This exercises the package
// export used by the generated OpenCode wrapper, including NATS query replies.
await import("./production-plugin-smoke.js");
