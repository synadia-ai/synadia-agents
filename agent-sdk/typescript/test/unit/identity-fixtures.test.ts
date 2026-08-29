// Consistency checks on the repo-level identity fixtures
// (`test-fixtures/identity/`, shared by all four SDK test suites):
//
//   - every `nkey: "U…"` literal in each fixture `.conf` is one of the
//     throwaway users in `keys.json`, and each config names exactly the
//     users its topology promises. The configs carry literal keys (no
//     templating), so a regenerated `keys.json` without a matching config
//     edit fails here — not as an auth error deep in a server log;
//   - `agent-id-fixtures.json` is well-formed.
//
// No server needed. The client package carries the same file plus the
// `@nats-io/nkeys` seed/CRC checks; this package has no direct nkeys
// dependency, so those stay there.

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { IDENTITY_FIXTURES_DIR, identityFixture } from "../harness/nats-server.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}

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

interface AgentIdFixtures {
  readonly regex: string;
  readonly parse: ReadonlyArray<ParseRow>;
  readonly new: ReadonlyArray<NewRow>;
}

/** Which keys.json users each fixture config must name — its topology, pinned. */
const EXPECTED_USERS_PER_CONF: Readonly<Record<string, ReadonlyArray<string>>> = {
  "nkey-noaccounts.conf": ["alice"],
  "nkey-deny-sys.conf": ["alice"],
  "accounts.conf": ["alice", "bob", "carol", "dave", "erin"],
  "account-token-position.conf": ["alice", "bob", "dave"],
};

const ALL_USERS = ["alice", "bob", "carol", "dave", "erin"];
const USER_KEY = /^U[A-Z2-7]{55}$/;
const USER_SEED = /^SU[A-Z2-7]{56}$/;
const NKEY_LITERAL = /nkey:\s*"([^"]*)"/g;
const OPERATOR_FORM_LENGTH = 113;
const SPEC_ROW_COUNT = 10;

async function loadJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(identityFixture(name), "utf8")) as T;
}

describe("test-fixtures/identity — keys.json", () => {
  it("lists the five throwaway users with well-formed key pairs", async () => {
    const keys = await loadJson<KeysFile>("keys.json");
    expect(Object.keys(keys.users).sort()).toEqual(ALL_USERS);
    for (const [name, { public: pub, seed }] of Object.entries(keys.users)) {
      expect(pub, name).toMatch(USER_KEY);
      expect(seed, name).toMatch(USER_SEED);
    }
    expect(new Set(Object.values(keys.users).map((u) => u.public)).size).toBe(ALL_USERS.length);
  });
});

describe("test-fixtures/identity — nats-server configs", () => {
  it("every nkey literal is a keys.json user and each config names its topology's users", async () => {
    const keys = await loadJson<KeysFile>("keys.json");
    const byPublic = new Map(Object.entries(keys.users).map(([name, u]) => [u.public, name]));
    const confs = (await readdir(IDENTITY_FIXTURES_DIR)).filter((f) => f.endsWith(".conf")).sort();
    expect(confs).toEqual(Object.keys(EXPECTED_USERS_PER_CONF).sort());

    const used = new Set<string>();
    for (const conf of confs) {
      const text = await readFile(identityFixture(conf), "utf8");
      const literals = [...text.matchAll(NKEY_LITERAL)].map((m) => m[1] ?? "");
      expect(literals.length, conf).toBeGreaterThan(0);
      const names = literals.map((key) => {
        const name = byPublic.get(key);
        expect(name, `${conf}: nkey literal ${key} is not in keys.json`).toBeDefined();
        return name ?? "";
      });
      expect([...new Set(names)].sort(), conf).toEqual([...EXPECTED_USERS_PER_CONF[conf]!].sort());
      for (const name of names) used.add(name);
    }
    // No orphan users: every key in keys.json is wired into some topology.
    expect([...used].sort()).toEqual(Object.keys(keys.users).sort());
  });
});

describe("test-fixtures/identity — agent-id-fixtures.json", () => {
  it("carries the spec's ten parse rows first, then the extra rows; valid rows split cleanly", async () => {
    const f = await loadJson<AgentIdFixtures>("agent-id-fixtures.json");
    expect(f.parse.length).toBeGreaterThanOrEqual(SPEC_ROW_COUNT);
    expect(f.parse.slice(0, SPEC_ROW_COUNT).map((r) => r.valid)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    const regex = new RegExp(f.regex);
    for (const row of f.parse) {
      if (row.valid) {
        expect(row.account, row.note).toBeDefined();
        expect(row.user, row.note).toBeDefined();
        expect(row.input, row.note).toBe(`${row.account}.${row.user}`);
        expect(row.input, row.note).toMatch(regex);
        expect(row.user, row.note).toMatch(USER_KEY);
        if (row.length !== undefined) expect(row.input.length, row.note).toBe(row.length);
      } else {
        // The shape regex rejects every invalid row except the bad-CRC one —
        // catching that is the nkeys library check's job, not the regex's.
        expect(regex.test(row.input), row.note).toBe(row.note.includes("CRC"));
      }
    }
    expect(f.parse[0]?.input.length).toBe(OPERATOR_FORM_LENGTH);
  });

  it("`new` rows: valid ones round-trip to their canonical string", async () => {
    const f = await loadJson<AgentIdFixtures>("agent-id-fixtures.json");
    expect(f.new.length).toBeGreaterThan(0);
    for (const row of f.new) {
      if (row.valid) expect(row.string, row.note).toBe(`${row.account}.${row.user}`);
      else expect(row.note.length, "invalid rows say why").toBeGreaterThan(0);
    }
  });
});
