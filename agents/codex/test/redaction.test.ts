import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexChannelConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { buildAgentServiceOptions } from "../src/service.js";
import { assertNoPrivateValues, redactPrivateText } from "../src/redaction.js";

describe("manager redaction", () => {
  test("keeps private endpoint and raw thread ids out of public metadata and doctor output", async () => {
    const privateEndpoint = "unix:///Users/alice/private/codex.sock";
    const rawThread = "raw-private-thread-alpha";
    const config: CodexChannelConfig = {
      nats: { url: "nats://127.0.0.1:4222", creds: "/Users/alice/.nats/secret.creds" },
      agent: { owner: "local", session: "session-deadbeef0000", subjectToken: "codex", heartbeatIntervalS: 30, keepaliveIntervalS: 30 },
      codex: { mode: "manager", codexBin: "codex", endpoint: privateEndpoint, threadId: rawThread, permissionPolicy: "external-owner" },
      manager: { enabled: true, autoExposeCurrentSessions: true, autoExposeFutureSessions: false, watchMode: "event-plus-poll", watchIntervalMs: 7500, staleGraceIntervals: 3, exposeEphemeralLoadedSessions: false, endpoints: [privateEndpoint] },
    };
    const opts = buildAgentServiceOptions({ nc: {} as never, config, version: "0.1.0" });
    const doctor = await runDoctor(config);
    assertNoPrivateValues("service options", opts, [privateEndpoint, rawThread, "/Users/alice"]);
    assertNoPrivateValues("doctor", doctor, [privateEndpoint, rawThread, "/Users/alice/private"]);
    expect(redactPrivateText(`connect ${privateEndpoint} ${rawThread}`)).not.toContain(privateEndpoint);
  });

  test("README examples avoid private raw endpoint/thread values and do not overclaim GUI discovery", () => {
    const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
    expect(readme).toContain("attachments_ok=false");
    expect(readme).not.toMatch(/all Codex (GUI|windows|sessions)/i);
    expect(readme).not.toContain("raw-private-thread");
    expect(readme).not.toContain("SYNADIA_CODEX_ENDPOINT_AUTH=token");
  });
});
