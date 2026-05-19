#!/usr/bin/env bun
// Manual smoke test — not wired into CI.
//
// Spawns the bridge in a subprocess, sends one NATS prompt, asserts at
// least one response chunk + the empty-headerless terminator arrive,
// then tears down.
//
// Requires:
//   - OPENAI_API_KEY (or CODEX_API_KEY) in env
//   - Reachable nats-server (default: nats://127.0.0.1:4222 — override
//     with NATS_URL)
//   - `npx` on PATH, or CODEX_ACP_COMMAND set

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "@nats-io/transport-node";

const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";
const OWNER = process.env.SMOKE_OWNER ?? process.env.USER ?? "smoke";
const SESSION = process.env.SMOKE_SESSION ?? `smoke-${process.pid}`;
const SUBJECT = `agents.prompt.codex.${OWNER}.${SESSION}`;
const PROMPT = process.env.SMOKE_PROMPT ?? "reply with the single word: pong";

function log(...args) {
  process.stderr.write(`[smoke] ${args.join(" ")}\n`);
}

async function main() {
  log("spawning bridge", { subject: SUBJECT, NATS_URL });
  const child = spawn(
    "bun",
    ["run", "src/cli.ts", "--owner", OWNER, "--session", SESSION, "--nats-url", NATS_URL],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, NATS_URL },
    },
  );
  child.on("exit", (code, signal) => {
    log(`bridge exited code=${code} signal=${signal ?? ""}`);
  });

  // Wait for the bridge to register. AgentService publishes the first
  // heartbeat immediately, but we sleep a bit to be safe.
  await delay(2000);

  const nc = await connect({ servers: NATS_URL });
  try {
    log("sending prompt", PROMPT);
    let sawResponse = false;
    let sawTerminator = false;
    // Subscribe to a dynamic inbox and publish manually so we can count
    // streamed reply chunks (the SDK `request` API collapses them).
    const sub = nc.subscribe(`_INBOX.smoke.${process.pid}.>`);
    const reply = `_INBOX.smoke.${process.pid}.req`;
    nc.publish(SUBJECT, new TextEncoder().encode(PROMPT), { reply });
    const deadline = Date.now() + 90_000;
    for await (const msg of sub) {
      if (msg.subject !== reply) continue;
      if (msg.data.length === 0) {
        sawTerminator = true;
        log("terminator received");
        break;
      }
      try {
        const decoded = JSON.parse(new TextDecoder().decode(msg.data));
        log(`chunk: ${decoded.type}${decoded.type === "response" ? ` text=${(decoded.text ?? decoded.data ?? "").slice(0, 60).replace(/\n/g, "\\n")}` : ""}`);
        if (decoded.type === "response") sawResponse = true;
      } catch (e) {
        log("non-JSON chunk", String(e));
      }
      if (Date.now() > deadline) {
        log("deadline exceeded");
        break;
      }
    }
    sub.unsubscribe();

    if (!sawResponse) {
      log("FAIL: no response chunk received");
      process.exitCode = 1;
    } else if (!sawTerminator) {
      log("FAIL: no terminator received");
      process.exitCode = 1;
    } else {
      log("PASS");
    }
  } finally {
    log("tearing down");
    child.kill("SIGTERM");
    await delay(500);
    await nc.close();
  }
}

main().catch((err) => {
  log("fatal", err?.stack ?? String(err));
  process.exit(1);
});
