#!/usr/bin/env bun
// Maintained production plugin lifecycle smoke. This exercises the package
// export used by the generated OpenCode wrapper, not the old spike core.
await import("./production-plugin-smoke.js");
