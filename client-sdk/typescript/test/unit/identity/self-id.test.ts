// `$SYS.REQ.USER.INFO` reply → agent ID, over stubbed replies (T1′ unit
// rows): password user name, `[REDACTED]`, unrepresentable names, an
// operator-mode `A…` account (113-char ID), unknown fields tolerated.

import { readFile } from "node:fs/promises";
import type { NatsConnection } from "@nats-io/nats-core";
import { describe, expect, it } from "vitest";
import { identityFixture } from "../../harness/nats-server.js";
import { IdentityError, IdentityUnavailableError, NoIdentityError } from "../../../src/errors.js";
import type { AgentId } from "../../../src/identity/agent-id.js";
import {
  identityFromUserInfoReply,
  selfId,
  startSelfIdLookup,
} from "../../../src/identity/self-id.js";
import { signerFromSeed } from "../../../src/identity/signer.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const keys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as KeysFile;
const U = keys.users["alice"]!.public;
const A = "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRL";

const reply = (data: Record<string, unknown>): unknown => ({
  server: { name: "x" },
  data: { permissions: {}, expires: 0, ...data },
});

function stubConnection(): { nc: NatsConnection; requests: () => number } {
  let requests = 0;
  const data = new TextEncoder().encode(JSON.stringify(reply({ user: U, account: "$G" })));
  const nc = {
    request: () => {
      requests += 1;
      return Promise.resolve({ data });
    },
    status: () =>
      (async function* (): AsyncGenerator<never> {
        await Promise.resolve();
        return;
      })(),
  } as unknown as NatsConnection;
  return { nc, requests: () => requests };
}

describe("identityFromUserInfoReply", () => {
  it("NGS / operator mode: 113-char ID", () => {
    expect(identityFromUserInfoReply(reply({ user: U, account: A }))).toBe(`${A}.${U}`);
  });

  it("config-file server: account name, and $G (unknown fields like account_name ignored)", () => {
    expect(
      identityFromUserInfoReply(reply({ user: U, account: "ACME", account_name: "ACME" })),
    ).toBe(`ACME.${U}`);
    expect(identityFromUserInfoReply(reply({ user: U, account: "$G", account_name: "$G" }))).toBe(
      `$G.${U}`,
    );
  });

  it.each([
    ["no auth", { user: "", account: "$G" }, /no authentication/],
    ["password user", { user: "alice", account: "$G" }, /password authentication/],
    ["token user", { user: "[REDACTED]", account: "$G" }, /token authentication/],
    ["name with a space", { user: U, account: "acme corp" }, /cannot be carried/],
    ["name with a dot", { user: U, account: "a.b" }, /cannot be carried/],
    ["name over 64 bytes", { user: U, account: "x".repeat(65) }, /longer than 64/],
    ["bad-CRC account key", { user: U, account: A.slice(0, 55) + "M" }, /cannot be carried/],
  ])("NoIdentityError: %s", (_label, data, re) => {
    let caught: unknown;
    try {
      identityFromUserInfoReply(reply(data));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NoIdentityError);
    expect((caught as Error).message).toMatch(re);
    expect((caught as Error).message).toMatch(/configure an nkey user|credentials file/);
  });

  it("IdentityUnavailableError for the wrong shape or an error reply", () => {
    expect(() => identityFromUserInfoReply("nope")).toThrow(IdentityUnavailableError);
    expect(() => identityFromUserInfoReply({})).toThrow(IdentityUnavailableError);
    expect(() => identityFromUserInfoReply({ data: { user: 1, account: "$G" } })).toThrow(
      IdentityUnavailableError,
    );
    expect(() => identityFromUserInfoReply({ error: { code: 500 } })).toThrow(
      IdentityUnavailableError,
    );
  });
});

describe("selfId signer cache key", () => {
  it.each(["not-a-jwt", "e30.e30."])(
    "contains malformed or unusable JWT validation inside the async lookup (%s)",
    async (jwt) => {
      const signer = signerFromSeed(keys.users["alice"]!.seed, jwt);
      try {
        const direct = stubConnection();
        let result: Promise<AgentId> | undefined;
        expect(() => {
          result = selfId(direct.nc, { signer });
        }).not.toThrow();
        await expect(result).rejects.toBeInstanceOf(IdentityError);
        expect(direct.requests()).toBe(1);

        const background = stubConnection();
        expect(() => startSelfIdLookup(background.nc, { signer })).not.toThrow();
        await Promise.resolve();
        expect(background.requests()).toBe(1);
      } finally {
        signer.wipe?.();
      }
    },
  );
});
