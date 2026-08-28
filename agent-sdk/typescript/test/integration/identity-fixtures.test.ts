// Smoke tests for the config-capable harness against the repo-level
// identity fixtures: each fixture config boots on a per-file server, the
// throwaway users authenticate with their seeds, and each topology does
// what its header comment says (deny `$SYS.>` bites; cross-account imports
// deliver; `account_token_position` inserts the token; JetStream comes up
// on `-js`). These prove the fixtures and the harness — the identity
// behaviour itself (Agent-Sender, selfId, …) is tested elsewhere.
//
// Skipped cleanly when `nats-server` is not on PATH. Byte-identical in the
// client and host packages (both carry the same harness).

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Empty,
  nkeyAuthenticator,
  PermissionViolationError,
  RequestError,
  type NatsConnection,
} from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { afterEach, describe, expect, it } from "vitest";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}

const bin = await findNatsServerBinary();
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const enc = new TextEncoder();
const dec = new TextDecoder();

function seedOf(name: string): Uint8Array {
  const user = keys.users[name];
  if (!user) throw new Error(`no such fixture user: ${name}`);
  return enc.encode(user.seed);
}

function connectAs(server: NatsServerProcess, name: string): Promise<NatsConnection> {
  return connect({
    servers: server.url,
    authenticator: nkeyAuthenticator(seedOf(name)),
    reconnect: false,
    timeout: 2_000,
  });
}

describe.skipIf(!bin)("identity fixtures — nats-server topologies", () => {
  const server = new NatsServerProcess();
  const open: NatsConnection[] = [];

  afterEach(async () => {
    for (const nc of open.splice(0)) await nc.close();
    await server.stop();
  });

  it("nkey-noaccounts.conf: alice authenticates with her seed; an anonymous connect is refused", async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    const alice = await connectAs(server, "alice");
    open.push(alice);

    const sub = alice.subscribe("fixture.echo", { max: 1 });
    const echo = (async () => {
      for await (const m of sub) m.respond(m.data);
    })();
    const reply = await alice.request("fixture.echo", enc.encode("hi"), { timeout: 2_000 });
    await echo;
    expect(dec.decode(reply.data)).toBe("hi");

    await expect(
      connect({ servers: server.url, reconnect: false, timeout: 2_000 }),
    ).rejects.toBeDefined();
  });

  it("nkey-deny-sys.conf: alice connects, but $SYS.REQ.USER.INFO is a permissions violation", async () => {
    await server.start({ configPath: identityFixture("nkey-deny-sys.conf") });
    const alice = await connectAs(server, "alice");
    open.push(alice);

    // nats-core fails the pending request at once (no 2 s timeout): a
    // RequestError whose `cause` is the PermissionViolationError.
    const err: unknown = await alice.request("$SYS.REQ.USER.INFO", Empty, { timeout: 2_000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).message).toMatch(/Permissions Violation for Publish/);
    expect((err as RequestError).cause).toBeInstanceOf(PermissionViolationError);
    // The violation is not fatal: the connection stays usable.
    await alice.flush();
    expect(alice.isClosed()).toBe(false);
  });

  it("accounts.conf: all five users authenticate; the ACME export reaches bob, dave and erin's imports", async () => {
    await server.start({ configPath: identityFixture("accounts.conf") });
    const [alice, bob, carol, dave, erin] = await Promise.all([
      connectAs(server, "alice"),
      connectAs(server, "bob"),
      connectAs(server, "carol"),
      connectAs(server, "dave"),
      connectAs(server, "erin"),
    ]);
    open.push(alice, bob, carol, dave, erin);

    const sub = alice.subscribe("agents.>");
    const responder = (async () => {
      for await (const m of sub) m.respond(enc.encode(`alice saw ${m.subject}`));
    })();
    await alice.flush();

    const expected = "alice saw agents.prompt.a.o.n";
    const ask = async (nc: NatsConnection, subject: string): Promise<string> =>
      dec.decode((await nc.request(subject, Empty, { timeout: 2_000 })).data);

    expect(await ask(carol, "agents.prompt.a.o.n"), "carol, same account").toBe(expected);
    expect(await ask(bob, "agents.prompt.a.o.n"), "bob (APP), share: true").toBe(expected);
    expect(await ask(dave, "agents.prompt.a.o.n"), "dave (APP2), no share").toBe(expected);
    // erin (APP3) publishes the renamed local subject; alice receives the exporter's.
    expect(await ask(erin, "local.agents.prompt.a.o.n"), "erin (APP3), to: local.agents.>").toBe(
      expected,
    );

    sub.unsubscribe();
    await responder;
  });

  it("account-token-position.conf: the server inserts the caller's account token", async () => {
    await server.start({ configPath: identityFixture("account-token-position.conf") });
    const [alice, bob, dave] = await Promise.all([
      connectAs(server, "alice"),
      connectAs(server, "bob"),
      connectAs(server, "dave"),
    ]);
    open.push(alice, bob, dave);

    const sub = alice.subscribe("svc.*.prompt");
    const responder = (async () => {
      for await (const m of sub) m.respond(enc.encode(m.subject));
    })();
    await alice.flush();

    const arrival = async (nc: NatsConnection, subject: string): Promise<string> =>
      dec.decode((await nc.request(subject, Empty, { timeout: 2_000 })).data);

    expect(await arrival(bob, "svc.prompt"), "bob via `to: svc.prompt`").toBe("svc.APP.prompt");
    expect(await arrival(bob, "svc.APP.prompt"), "bob via the plain import").toBe("svc.APP.prompt");
    expect(await arrival(dave, "svc.APP2.prompt"), "dave (APP2)").toBe("svc.APP2.prompt");

    sub.unsubscribe();
    await responder;
  });

  it("start({ jetstream: true }) enables JetStream on a throwaway store dir", async () => {
    await server.start({ jetstream: true });
    expect(server.storeDir).not.toBeNull();
    const nc = await connect({ servers: server.url, reconnect: false, timeout: 2_000 });
    open.push(nc);
    expect(nc.info?.jetstream).toBe(true);
  });

  it("a config the server rejects fails start() fast, with the server's stderr in the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synadia-bad-conf-"));
    try {
      const bad = join(dir, "bad.conf");
      await writeFile(bad, 'authorization { users: [ { nkey: "NOTAKEY" } ] }\n');
      const started = Date.now();
      await expect(server.start({ configPath: bad })).rejects.toThrow(
        /exited before listening[\s\S]*Not a valid public nkey/,
      );
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
