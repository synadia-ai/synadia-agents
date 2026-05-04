// Integration test for `runBridge` — end-to-end against a real
// nats-server, but with the AI SDK swapped out for a stub `agentFactory`.
// The flow exercised here mirrors the v1 demo: SDK caller → bridge →
// stubbed model → SDK stream → terminator.

import {
  describe,
  expect,
  test,
  beforeAll,
  afterAll,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { Agents, ServiceError } from "@synadia-ai/agents";

import { runBridge, type AgentFactory } from "../src/bridge.js";
import { connectLocalSandbox } from "../vendor/sandbox/local.js";
import { NatsServerNotAvailableError, NatsServerProcess } from "./harness/nats-server.js";

const server = new NatsServerProcess();
let serverAvailable = true;
let workdir = "";

beforeAll(async () => {
  try {
    await server.start();
  } catch (err) {
    if (err instanceof NatsServerNotAvailableError) {
      serverAvailable = false;
      console.warn(
        "⚠ nats-server not on PATH — bridge.integration.test.ts will be skipped",
      );
      return;
    }
    throw err;
  }
  workdir = await mkdtemp(join(tmpdir(), "open-agent-it-"));
});

afterAll(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true });
  await server.stop();
});

function maybeSkip<T>(fn: () => Promise<T>): () => Promise<T | void> {
  return async () => {
    if (!serverAvailable) return;
    return fn();
  };
}

async function withSession(
  fn: (ctx: {
    nc: NatsConnection;
    agents: Agents;
    bridgeStop: () => Promise<void>;
    owner: string;
    session: string;
  }) => Promise<void>,
  opts: { agentFactory: AgentFactory },
): Promise<void> {
  const owner = "test";
  const session = `s-${Math.floor(Math.random() * 1e9).toString(36)}`;

  const bridgeNc = await connect({ servers: server.url });
  const callerNc = await connect({ servers: server.url });

  const { stop: bridgeStop } = await runBridge({
    nc: bridgeNc,
    owner,
    session,
    sandboxFactory: async () => {
      const sandbox = await connectLocalSandbox({
        type: "local",
        workingDirectory: workdir,
      });
      return { sandbox, state: { type: "local", workingDirectory: workdir } };
    },
    agentFactory: opts.agentFactory,
  });

  const agents = new Agents({ nc: callerNc });
  try {
    await fn({ nc: callerNc, agents, bridgeStop, owner, session });
  } finally {
    await agents.close();
    await callerNc.close();
    await bridgeStop();
    await bridgeNc.close();
  }
}

describe("runBridge integration", () => {
  test(
    "discovery returns the open-agent service",
    maybeSkip(async () => {
      const echoFactory: AgentFactory = async (input) => ({
        stream: (async function* () {
          yield { type: "text-delta", id: "t", delta: `echo: ${input.history.at(-1)?.content as string}` };
        })(),
        waitForResult: async () => [],
      });

      await withSession(
        async ({ agents }) => {
          const found = await agents.discover({ timeoutMs: 1500 });
          const ours = found.find(
            (a: import("@synadia-ai/agents").Agent) => a.agent === "open-agent",
          );
          expect(ours).toBeDefined();
          expect(ours?.protocolVersion).toBe("0.3");
        },
        { agentFactory: echoFactory },
      );
    }),
  );

  test(
    "prompt streams chunks and terminates",
    maybeSkip(async () => {
      const echoFactory: AgentFactory = async (input) => ({
        stream: (async function* () {
          const last = input.history.at(-1)?.content as string;
          yield { type: "text-delta", id: "t", delta: `hello, ${last}` };
        })(),
        waitForResult: async () => [],
      });

      await withSession(
        async ({ agents, owner, session }) => {
          const found = await agents.discover({ timeoutMs: 1500 });
          const ours = found.find(
            (a: import("@synadia-ai/agents").Agent) =>
              a.agent === "open-agent" && a.owner === owner && a.name === session,
          );
          expect(ours).toBeDefined();

          const stream = await ours!.prompt("world", { maxWaitMs: 5_000 });
          const collected: string[] = [];
          for await (const m of stream) {
            if (m.type === "response") collected.push(m.text);
          }
          expect(collected.join("")).toBe("hello, world");
        },
        { agentFactory: echoFactory },
      );
    }),
  );

  test(
    "ask round-trips through PromptResponse",
    maybeSkip(async () => {
      const queryFactory: AgentFactory = async (input) => {
        // Send a query via the response handle inside the stream.
        const generator = (async function* () {
          yield { type: "text-delta", id: "t", delta: "asking… " };
          const reply = await input.response.ask("pick one", { timeoutMs: 5_000 });
          yield { type: "text-delta", id: "t", delta: `got: ${reply.prompt}` };
        })();
        return {
          stream: generator,
          waitForResult: async () => [],
        };
      };

      await withSession(
        async ({ agents, owner, session }) => {
          const found = await agents.discover({ timeoutMs: 1500 });
          const ours = found.find(
            (a: import("@synadia-ai/agents").Agent) =>
              a.agent === "open-agent" && a.owner === owner && a.name === session,
          );
          expect(ours).toBeDefined();

          const stream = await ours!.prompt("hi", { maxWaitMs: 8_000 });
          const text: string[] = [];
          for await (const m of stream) {
            if (m.type === "query") {
              await m.reply("option-1");
              continue;
            }
            if (m.type === "response") text.push(m.text);
          }
          expect(text.join("")).toContain("got: option-1");
        },
        { agentFactory: queryFactory },
      );
    }),
  );

  test(
    "handler errors surface as ServiceError + terminator",
    maybeSkip(async () => {
      const throwingFactory: AgentFactory = async () => ({
        stream: (async function* () {
          throw new Error("boom");
          yield { type: "text-delta", id: "t", delta: "" };
        })(),
        waitForResult: async () => [],
      });

      await withSession(
        async ({ agents, owner, session }) => {
          const found = await agents.discover({ timeoutMs: 1500 });
          const ours = found.find(
            (a: import("@synadia-ai/agents").Agent) =>
              a.agent === "open-agent" && a.owner === owner && a.name === session,
          );
          expect(ours).toBeDefined();

          const stream = await ours!.prompt("anything", { maxWaitMs: 5_000 });
          let caught: unknown;
          try {
            for await (const _ of stream) {
              // discard
            }
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(ServiceError);
          expect((caught as ServiceError).code).toBe(500);
        },
        { agentFactory: throwingFactory },
      );
    }),
  );

  test(
    "stream `error` parts surface as ServiceError(500) instead of being silently dropped",
    maybeSkip(async () => {
      const errorPartFactory: AgentFactory = async () => ({
        stream: (async function* () {
          yield { type: "text-delta", id: "t", delta: "starting…" };
          yield { type: "error", error: "model exploded" };
          // Anything past the error part should never run — the bridge
          // throws as soon as it sees the part.
          yield { type: "text-delta", id: "t", delta: "should-not-appear" };
        })(),
        waitForResult: async () => [],
      });

      await withSession(
        async ({ agents, owner, session }) => {
          const found = await agents.discover({ timeoutMs: 1500 });
          const ours = found.find(
            (a: import("@synadia-ai/agents").Agent) =>
              a.agent === "open-agent" && a.owner === owner && a.name === session,
          );
          expect(ours).toBeDefined();

          const stream = await ours!.prompt("hi", { maxWaitMs: 5_000 });
          const collected: string[] = [];
          let caught: unknown;
          try {
            for await (const m of stream) {
              if (m.type === "response") collected.push(m.text);
            }
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(ServiceError);
          expect((caught as ServiceError).code).toBe(500);
          expect(collected.join("")).not.toContain("should-not-appear");
        },
        { agentFactory: errorPartFactory },
      );
    }),
  );
});

describe("runBridge subject-token validation", () => {
  test(
    "owner with NATS special characters is rejected before service registration",
    maybeSkip(async () => {
      const nc = await connect({ servers: server.url });
      try {
        await expect(
          runBridge({
            nc,
            owner: "evil.attacker",
            session: "ok",
            sandboxFactory: async () => {
              throw new Error("sandboxFactory should not be called");
            },
          }),
        ).rejects.toThrow(/owner .* NATS special characters/);
      } finally {
        await nc.close();
      }
    }),
  );

  test(
    "session with a wildcard token is rejected",
    maybeSkip(async () => {
      const nc = await connect({ servers: server.url });
      try {
        await expect(
          runBridge({
            nc,
            owner: "ok",
            session: ">",
            sandboxFactory: async () => {
              throw new Error("sandboxFactory should not be called");
            },
          }),
        ).rejects.toThrow(/session .* NATS special characters/);
      } finally {
        await nc.close();
      }
    }),
  );

  test(
    "empty owner is rejected",
    maybeSkip(async () => {
      const nc = await connect({ servers: server.url });
      try {
        await expect(
          runBridge({
            nc,
            owner: "",
            session: "ok",
            sandboxFactory: async () => {
              throw new Error("sandboxFactory should not be called");
            },
          }),
        ).rejects.toThrow(/owner must be non-empty/);
      } finally {
        await nc.close();
      }
    }),
  );
});
