import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { Agents, isThreadId, signerFromSeed, type Agent } from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";

/**
 * Tracing interoperates with peers that have none — across languages and
 * versions. A traced TypeScript caller must be served by a Python host
 * that never opted in (which adopts its lineage) and by one that predates
 * the extension entirely (which ignores the two envelope fields, §5.6).
 * An untraced caller must be served by a traced Python host, which mints a
 * root of its own, and must see nothing of tracing on the wire.
 *
 * The Python host is `test-fixtures/interop/py-agent-service-host.py`,
 * run by `uv` inside the `agent-sdk/python` project. The cross-version
 * case needs the last published, pre-tracing `synadia-ai-agent-service`
 * in a venv of its own:
 *
 *   uv venv old-py && uv pip install --python old-py/bin/python \
 *     synadia-ai-agent-service==0.4.1 synadia-ai-agents==0.7.1 nkeys
 *   export SYNADIA_INTEROP_PRETRACING_PY_PYTHON=$PWD/old-py/bin/python
 *
 * and skips when that variable is unset. The Python SDK runs the mirror
 * image against a TypeScript host.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const HOST_SCRIPT = join(REPO_ROOT, "test-fixtures", "interop", "py-agent-service-host.py");
const AGENT_SDK_PY = join(REPO_ROOT, "agent-sdk", "python");
const PRETRACING_PY_ENV = "SYNADIA_INTEROP_PRETRACING_PY_PYTHON";
const READY_MARKER = "agent service listening on ";
const ECHO = /^echo: (.*?)(?: thread=([0-9a-f]{32}) root=([0-9a-f]{32}))?$/;

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const bin = await findNatsServerBinary();
const uvAvailable = spawnSync("uv", ["--version"]).status === 0;
const keys = JSON.parse(readFileSync(identityFixture("keys.json"), "utf8")) as KeysFile;
const ALICE = keys.users["alice"]!;
const enc = new TextEncoder();
const dec = new TextDecoder();

interface PyHost {
  readonly subject: string;
  stop(): Promise<void>;
}

async function startPyHost(opts: {
  readonly url: string;
  readonly agent: string;
  readonly traced?: boolean;
  readonly seedFile?: string;
  /** Interpreter to run the host with; default: the agent-sdk project via `uv`. */
  readonly python?: string;
}): Promise<PyHost> {
  const cmd = opts.python ?? "uv";
  const args = opts.python
    ? ["-u", HOST_SCRIPT]
    : ["run", "--project", AGENT_SDK_PY, "python", "-u", HOST_SCRIPT];
  const child: ChildProcess = spawn(cmd, args, {
    env: {
      ...process.env,
      NATS_URL: opts.url,
      AGENT: opts.agent,
      TRACE: opts.traced ? "1" : "0",
      ...(opts.seedFile ? { NATS_NKEY_SEED_FILE: opts.seedFile } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const subject = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`python host not ready in 30s:\n${out}`)),
      30_000,
    );
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      const line = out.split("\n").find((l) => l.includes(READY_MARKER));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line.split(READY_MARKER)[1]!.trim());
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`python host exited before ready (code=${code}):\n${out}`));
    });
  });
  return {
    subject,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }),
  };
}

function capture(nc: NatsConnection, subject: string): Msg[] {
  const seen: Msg[] = [];
  const sub = nc.subscribe(subject);
  void (async () => {
    for await (const m of sub) seen.push(m);
  })();
  return seen;
}

async function echo(
  agents: Agents,
  subject: string,
  text: string,
): Promise<{ prompt: string; thread?: string; root?: string }> {
  const found = await agents.discover({ timeoutMs: 3000 });
  const handle = found.find((a: Agent) => a.promptEndpoint.subject === subject);
  expect(handle, `host ${subject} not discovered`).toBeDefined();
  const texts: string[] = [];
  for await (const m of await handle!.prompt(text)) {
    if (m.type === "response") texts.push(m.text);
  }
  expect(texts).toHaveLength(1);
  const m = ECHO.exec(texts[0]!);
  expect(m, texts[0]).not.toBeNull();
  return { prompt: m![1]!, ...(m![2] ? { thread: m![2], root: m![3] } : {}) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!bin || !uvAvailable)("tracing interop with Python hosts (no auth)", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  beforeAll(async () => {
    await server.start();
    nc = await connect({ servers: server.url, reconnect: false });
  });
  afterAll(async () => {
    await nc.close();
    await server.stop();
  });

  it("a traced caller is adopted by an untraced Python host", async () => {
    const host = await startPyHost({ url: server.url, agent: "py-untraced" });
    try {
      await nc.flush();
      const prompts = capture(nc, host.subject);
      await nc.flush();
      const agents = new Agents({ nc, trace: { edgeSubject: null } });
      const seen = await echo(agents, host.subject, "hi");
      await agents.close();
      expect(seen.prompt).toBe("hi");
      const sent = JSON.parse(dec.decode(prompts[0]!.data)) as Record<string, string>;
      expect(isThreadId(sent["thread_id"]!)).toBe(true);
      expect(sent["root_id"]).toBe(sent["thread_id"]);
      // Adopted, not dropped or re-minted.
      expect(seen.thread).toBe(sent["thread_id"]);
      expect(seen.root).toBe(sent["root_id"]);
    } finally {
      await host.stop();
    }
  });

  it("an untraced caller is served by a traced Python host", async () => {
    const host = await startPyHost({ url: server.url, agent: "py-traced", traced: true });
    try {
      const prompts = capture(nc, host.subject);
      const traces = capture(nc, "TRACE.>");
      await nc.flush();
      const agents = new Agents({ nc }); // never traced
      const seen = await echo(agents, host.subject, "hi");
      await agents.close();
      expect(seen.prompt).toBe("hi");
      expect(dec.decode(prompts[0]!.data)).toBe('{"prompt":"hi"}');
      expect(seen.thread).toBeDefined();
      expect(seen.root).toBe(seen.thread);
      await sleep(200);
      expect(traces).toHaveLength(0);
    } finally {
      await host.stop();
    }
  });
});

describe.skipIf(!bin || !uvAvailable)("tracing interop with Python hosts (nkey)", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let seedFile: string;
  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    nc = await connect({
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    });
    seedFile = join(mkdtempSync(join(tmpdir(), "interop-trace-")), "alice.nk");
    writeFileSync(seedFile, `${ALICE.seed}\n`, { mode: 0o600 });
  });
  afterAll(async () => {
    await nc.close();
    await server.stop();
  });

  function tracedAgents(): Agents {
    return new Agents({ nc, identity: { signer: signerFromSeed(ALICE.seed) }, trace: {} });
  }

  it("a traced caller publishes edges while talking to an untraced Python host", async () => {
    const host = await startPyHost({ url: server.url, agent: "py-untraced-nk", seedFile });
    try {
      const edges = capture(nc, "TRACE.edges");
      await nc.flush();
      const agents = tracedAgents();
      const seen = await echo(agents, host.subject, "hi");
      await agents.close();
      expect(seen.prompt).toBe("hi");
      await sleep(200);
      expect(edges).toHaveLength(1);
      const record = JSON.parse(dec.decode(edges[0]!.data)) as Record<string, unknown>;
      expect(record["thread_id"]).toBe(seen.thread);
      expect(record["parent_id"]).toBeNull();
      expect(edges[0]!.headers?.get("Agent-Sender")).toBeTruthy();
    } finally {
      await host.stop();
    }
  });

  it.skipIf(process.env[PRETRACING_PY_ENV] === undefined)(
    "a traced caller is served by the last published Python host",
    async () => {
      const host = await startPyHost({
        url: server.url,
        agent: "py-old",
        seedFile,
        python: process.env[PRETRACING_PY_ENV]!,
      });
      try {
        const edges = capture(nc, "TRACE.edges");
        await nc.flush();
        const agents = tracedAgents();
        const seen = await echo(agents, host.subject, "hello old host");
        await agents.close();
        expect(seen.prompt).toBe("hello old host");
        expect(seen.thread).toBeUndefined(); // nothing to echo before tracing existed
        await sleep(200);
        expect(edges).toHaveLength(1);
      } finally {
        await host.stop();
      }
    },
  );
});
