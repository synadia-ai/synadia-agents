import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  Agents,
  AGENT_SENDER_HEADER,
  resolveNatsConnectionBundle,
  type Agent,
  type NatsConnectionBundle,
  type SenderSigner,
} from "@synadia-ai/agents";

import { ClaudeSessionManager } from "../src/claude-session-manager.js";
import { Controller } from "../src/controller.js";
import {
  controllerSpawnSubject,
  controllerStopSubject,
} from "../src/subjects.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../../../client-sdk/typescript/test/harness/nats-server.js";

const natsServer = await findNatsServerBinary();

describe.skipIf(!natsServer)("AgentService controller and logical sessions", () => {
  test("identity-off mode remains headerless and permissive", async () => {
    const server = new NatsServerProcess();
    const cwd = await mkdtemp(join(tmpdir(), "cc-headless-off-"));
    let bundle: NatsConnectionBundle | undefined;
    let nc: Awaited<ReturnType<typeof connect>> | undefined;
    let agents: Agents | undefined;
    let manager: ClaudeSessionManager | undefined;
    let controller: Controller | undefined;
    try {
      await server.start();
      bundle = await resolveNatsConnectionBundle({ url: server.url }, { identity: "off" });
      nc = await connect(bundle.connectionOptions);
      manager = makeManager(nc, "off-owner", "any");
      await manager.start();
      controller = new Controller({
        nc,
        owner: "off-owner",
        name: "control",
        manager,
        minSenderTrust: "any",
      });
      await controller.start();
      agents = new Agents({ nc });

      const controllerAgent = await findAgent(agents, "controller");
      expect(controllerAgent.identity).toBeUndefined();
      expect(controllerAgent.minSenderTrust).toBe("any");
      let help = "";
      for await (const event of await controllerAgent.prompt("help")) {
        if (event.type === "response") help += event.text;
      }
      expect(help).toContain("control-plane agent");

      const descriptor = await spawnViaEndpoint(nc, "off-owner", cwd);
      const session = await agents.lookupInstance(descriptor.instance_id, { timeoutMs: 1_000 });
      expect(session?.identity).toBeUndefined();
      expect(session?.minSenderTrust).toBe("any");
      await stopViaEndpoint(nc, "off-owner", descriptor.session_id);
    } finally {
      await controller?.stop().catch(() => undefined);
      await manager?.stop().catch(() => undefined);
      await agents?.close().catch(() => undefined);
      await closeAndWipe(nc, bundle);
      await server.stop().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("controller and sessions share one signed connection identity", async () => {
    const server = new NatsServerProcess();
    const cwd = await mkdtemp(join(tmpdir(), "cc-headless-signed-"));
    let hostBundle: Awaited<ReturnType<typeof resolveNatsConnectionBundle>> | undefined;
    let callerBundle: Awaited<ReturnType<typeof resolveNatsConnectionBundle>> | undefined;
    let hostNc: Awaited<ReturnType<typeof connect>> | undefined;
    let callerNc: Awaited<ReturnType<typeof connect>> | undefined;
    let signedAgents: Agents | undefined;
    let manager: ClaudeSessionManager | undefined;
    let controller: Controller | undefined;
    try {
      await server.start({ configPath: identityFixture("operator/operator.conf") });
      hostBundle = await resolveNatsConnectionBundle(
        { url: server.url, creds: identityFixture("operator/alice.creds") },
        { identity: "signed" },
      );
      hostNc = await connect(hostBundle.connectionOptions);
      manager = makeManager(hostNc, "signed-owner", "signed", hostBundle.signer);
      await manager.start();
      controller = new Controller({
        nc: hostNc,
        owner: "signed-owner",
        name: "control",
        manager,
        signer: hostBundle.signer,
        minSenderTrust: "signed",
      });
      await controller.start();

      callerBundle = await resolveNatsConnectionBundle(
        { url: server.url, creds: identityFixture("operator/carol.creds") },
        { identity: "signed" },
      );
      callerNc = await connect(callerBundle.connectionOptions);
      signedAgents = new Agents({
        nc: callerNc,
        identity: { signer: callerBundle.signer, name: "headless-test-caller" },
      });

      const controllerAgent = await findAgent(signedAgents, "controller");
      expect(controllerAgent.identity).toBeDefined();
      expect(controllerAgent.idSigVerified).toBe(true);
      expect(controllerAgent.minSenderTrust).toBe("signed");
      await expectHeaderlessRefusal(callerNc, controllerAgent);
      const status = await callerNc.request(
        "agents.status.cc-headless.signed-owner.control",
        "",
        { timeout: 1_000 },
      );
      expect(JSON.parse(status.string())).toMatchObject({
        agent: "cc-headless",
        owner: "signed-owner",
      });

      // Extension endpoints retain their existing request/reply behavior. The
      // strict sender policy belongs to protocol prompt admission.
      const descriptor = await spawnViaEndpoint(callerNc, "signed-owner", cwd);
      const session = await signedAgents.lookupInstance(descriptor.instance_id, {
        timeoutMs: 1_000,
      });
      expect(session).not.toBeNull();
      expect(session!.identity).toBe(controllerAgent.identity);
      expect(session!.idSigVerified).toBe(true);
      expect(session!.minSenderTrust).toBe("signed");
      await expectHeaderlessRefusal(callerNc, session!);

      let help = "";
      for await (const event of await controllerAgent.prompt("help")) {
        if (event.type === "response") help += event.text;
      }
      expect(help).toContain("logical NATS agent");
      await stopViaEndpoint(callerNc, "signed-owner", descriptor.session_id);
    } finally {
      await controller?.stop().catch(() => undefined);
      await manager?.stop().catch(() => undefined);
      await signedAgents?.close().catch(() => undefined);
      await closeAndWipe(callerNc, callerBundle);
      await closeAndWipe(hostNc, hostBundle);
      await server.stop().catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function closeAndWipe(
  nc: Awaited<ReturnType<typeof connect>> | undefined,
  bundle: NatsConnectionBundle | undefined,
): Promise<void> {
  if (!bundle) return;
  if (nc) await nc.drain();
  bundle.wipe();
}

function makeManager(
  nc: Awaited<ReturnType<typeof connect>>,
  owner: string,
  minSenderTrust: "any" | "signed",
  signer?: SenderSigner,
): ClaudeSessionManager {
  return new ClaudeSessionManager({
    nc,
    owner,
    defaultModel: "test-model",
    defaultPermissionMode: "dontAsk",
    defaultAllowedTools: [],
    defaultMaxTurns: 1,
    defaultMaxLifetimeS: 60,
    minSenderTrust,
    ...(signer ? { signer } : {}),
  });
}

async function findAgent(agents: Agents, role: string): Promise<Agent> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const found = await agents.discover({
      timeoutMs: 150,
      filter: { agent: "cc-headless" },
    });
    const match = found.find((agent) => agent.metadata["role"] === role);
    if (match) return match;
  }
  throw new Error(`no ${role} discovered`);
}

async function spawnViaEndpoint(
  nc: Awaited<ReturnType<typeof connect>>,
  owner: string,
  cwd: string,
): Promise<{ session_id: string; instance_id: string }> {
  const reply = await nc.request(
    controllerSpawnSubject(owner, "control"),
    JSON.stringify({ cwd, session_id: "test-session" }),
    { timeout: 2_000 },
  );
  const code = reply.headers?.get("Nats-Service-Error-Code");
  if (code) throw new Error(`spawn failed ${code}: ${reply.headers?.get("Nats-Service-Error")}`);
  return JSON.parse(reply.string()) as { session_id: string; instance_id: string };
}

async function stopViaEndpoint(
  nc: Awaited<ReturnType<typeof connect>>,
  owner: string,
  sessionId: string,
): Promise<void> {
  await nc.request(
    controllerStopSubject(owner, "control"),
    JSON.stringify({ session_id: sessionId }),
    { timeout: 2_000 },
  );
}

async function expectHeaderlessRefusal(
  nc: Awaited<ReturnType<typeof connect>>,
  agent: Agent,
): Promise<void> {
  const inbox = `_INBOX.cc_headless.${crypto.randomUUID().replaceAll("-", "")}`;
  const sub = nc.subscribe(inbox);
  const replies: Array<{ code?: string; body: string }> = [];
  const collecting = (async () => {
    for await (const message of sub) {
      replies.push({
        code: message.headers?.get("Nats-Service-Error-Code") || undefined,
        body: message.string(),
      });
      if (message.data.byteLength === 0 && !message.headers) break;
    }
  })();
  // Publishing directly deliberately omits Agent-Sender.
  nc.publish(agent.promptEndpoint.subject, "unsigned", { reply: inbox });
  await nc.flush();
  await collecting;
  expect(replies[0]?.code).toBe("401");
  expect(replies.some((reply) => reply.body.includes('"status"'))).toBe(false);
  expect(replies.at(-1)?.body).toBe("");
  expect(replies.some((reply) => reply.body.includes(AGENT_SENDER_HEADER))).toBe(false);
}
