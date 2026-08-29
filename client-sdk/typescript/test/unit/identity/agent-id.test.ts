// Agent-ID parse fixtures (spec table + the plan's extra rows), equality,
// round trip, the 113-char operator form, empty tokens.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { identityFixture } from "../../harness/nats-server.js";
import {
  AGENT_ID_REGEX,
  agentIdAccount,
  agentIdUser,
  newAgentId,
  parseAgentId,
} from "../../../src/identity/agent-id.js";
import { IdentityError, InvalidAgentIdError } from "../../../src/errors.js";

interface ParseRow {
  readonly input: string;
  readonly valid: boolean;
  readonly account?: string;
  readonly user?: string;
  readonly length?: number;
  readonly note: string;
}
interface NewRow {
  readonly account: string;
  readonly user: string;
  readonly valid: boolean;
  readonly string?: string;
  readonly note: string;
}
interface Fixtures {
  readonly regex: string;
  readonly parse: ReadonlyArray<ParseRow>;
  readonly new: ReadonlyArray<NewRow>;
}

const fixtures = JSON.parse(
  await readFile(identityFixture("agent-id-fixtures.json"), "utf8"),
) as Fixtures;
const OPERATOR_FORM_LENGTH = 113;

describe("parseAgentId — fixture rows", () => {
  it("uses the spec regex verbatim", () => {
    expect(AGENT_ID_REGEX.source).toBe(new RegExp(fixtures.regex).source);
  });

  for (const row of fixtures.parse) {
    it(`${row.valid ? "accepts" : "rejects"}: ${row.note}`, () => {
      if (row.valid) {
        const id = parseAgentId(row.input);
        expect(id).toBe(row.input);
        expect(agentIdAccount(id)).toBe(row.account);
        expect(agentIdUser(id)).toBe(row.user);
        if (row.length !== undefined) expect(id.length).toBe(row.length);
      } else {
        expect(() => parseAgentId(row.input)).toThrow(InvalidAgentIdError);
      }
    });
  }
});

describe("newAgentId — fixture rows", () => {
  for (const row of fixtures.new) {
    it(`${row.valid ? "builds" : "rejects"}: ${row.note}`, () => {
      if (row.valid) {
        expect(newAgentId(row.account, row.user)).toBe(row.string);
      } else {
        expect(() => newAgentId(row.account, row.user)).toThrow(InvalidAgentIdError);
      }
    });
  }
});

describe("AgentId semantics", () => {
  const spec = fixtures.parse[0]!;
  const other = fixtures.parse.at(-1)!;

  it("is a branded string: equality is byte equality, usable as a Map key", () => {
    const a = parseAgentId(spec.input);
    const b = newAgentId(spec.account!, spec.user!);
    expect(a === b).toBe(true);
    const m = new Map([[a, 1]]);
    expect(m.get(b)).toBe(1);
    expect(parseAgentId(other.input) === a).toBe(false);
  });

  it("round-trips: parse(toString) loses nothing", () => {
    const id = parseAgentId(spec.input);
    expect(parseAgentId(`${agentIdAccount(id)}.${agentIdUser(id)}`)).toBe(id);
    expect(id.length).toBe(OPERATOR_FORM_LENGTH);
  });

  it("InvalidAgentIdError is an IdentityError, not a ValidationError", () => {
    expect(new InvalidAgentIdError("x")).toBeInstanceOf(IdentityError);
  });

  it("rejects an A-led 56-char account that is not a valid NKEY (the nkeys check runs on that shape)", () => {
    const fakeAccount = "A" + "b".repeat(55);
    expect(() => newAgentId(fakeAccount, spec.user!)).toThrow(InvalidAgentIdError);
  });

  it("rejects a seed where a public key is expected", () => {
    const seed = "SUAEJ6GDK6FSSB54LD45Q7W25AW7NUT7MVLBABIR5MIPFUTBW7ZNPK2KYE";
    expect(() => newAgentId("$G", seed)).toThrow(InvalidAgentIdError);
  });
});
