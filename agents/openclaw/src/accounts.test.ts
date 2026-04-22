// Account resolution tests. Requires the `openclaw` peer dependency (for the
// `OpenClawConfig` / `DEFAULT_ACCOUNT_ID` imports transitively pulled by
// `./accounts.js`). Skipped automatically when openclaw isn't resolvable, so
// the protocol tests can still run standalone on a fresh clone.

import { describe, it, expect } from "vitest";

let resolveNatsAccount: typeof import("./accounts.js").resolveNatsAccount;
let listNatsAccountIds: typeof import("./accounts.js").listNatsAccountIds;
let skip = false;
try {
  const mod = await import("./accounts.js");
  resolveNatsAccount = mod.resolveNatsAccount;
  listNatsAccountIds = mod.listNatsAccountIds;
} catch {
  skip = true;
}

describe.skipIf(skip)("account resolution", () => {
  it("returns sensible defaults for empty config (owner falls back to \"default\")", () => {
    const account = resolveNatsAccount({});
    expect(account.url).toBe("");
    expect(account.agentName).toBe("");
    expect(account.description).toBe("");
    expect(account.enabled).toBe(true);
    expect(account.owner).toBe("default");
  });

  it("resolves a configured account using the new 'owner' field", () => {
    const cfg = {
      channels: {
        nats: {
          accounts: {
            default: {
              url: "nats://my-server:4222",
              agentName: "my-agent",
              description: "My agent",
              owner: "acme",
            },
          },
        },
      },
    };
    const account = resolveNatsAccount(cfg, "default");
    expect(account.url).toBe("nats://my-server:4222");
    expect(account.agentName).toBe("my-agent");
    expect(account.description).toBe("My agent");
    expect(account.owner).toBe("acme");
  });

  it("accepts legacy 'org' as an alias for 'owner'", () => {
    const cfg = {
      channels: {
        nats: {
          accounts: {
            default: { agentName: "x", org: "legacy-team" },
          },
        },
      },
    };
    expect(resolveNatsAccount(cfg, "default").owner).toBe("legacy-team");
  });

  it("lists account IDs", () => {
    expect(listNatsAccountIds({}).length).toBeGreaterThan(0);
    const cfg = { channels: { nats: { accounts: { a: {}, b: {} } } } };
    expect(listNatsAccountIds(cfg).sort()).toEqual(["a", "b"]);
  });
});
