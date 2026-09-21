// Account resolution is deliberately host-independent: accounts.ts imports
// OpenClaw types only and delegates connection-source interpretation to the
// shared SDK helper at connect time.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { listNatsAccountIds, resolveNatsAccount } from "./accounts.js";

// Identity env vars that influence resolveNatsAccount. Cleared per-test so
// values leaking in from the invoking shell can't skew expectations, and
// restored afterwards.
const IDENTITY_ENV_VARS = [
  "SYNADIA_OPENCLAW_OWNER",
  "SYNADIA_OWNER",
  "NATS_OWNER",
  "NATS_ORG",
  "SYNADIA_OPENCLAW_NAME",
  "SYNADIA_NAME",
  "NATS_AGENT_NAME",
  "NATS_CREDENTIALS",
  "NATS_CREDS",
  "NATS_SENDER_IDENTITY",
  "NATS_MIN_SENDER_TRUST",
] as const;

function snapshotIdentityEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const v of IDENTITY_ENV_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  return saved;
}

function restoreIdentityEnv(saved: Record<string, string | undefined>): void {
  for (const v of IDENTITY_ENV_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
}

describe("account resolution", () => {
  let savedIdentity: Record<string, string | undefined>;
  beforeEach(() => {
    savedIdentity = snapshotIdentityEnv();
  });
  afterEach(() => {
    restoreIdentityEnv(savedIdentity);
  });

  it('returns sensible defaults for empty config (owner falls back to "default")', () => {
    const account = resolveNatsAccount({});
    expect(account.url).toBe("");
    expect(account.agentName).toBe("");
    expect(account.description).toBe("");
    expect(account.enabled).toBe(true);
    expect(account.owner).toBe("default");
    expect(account.connectionSource).toEqual({ url: "nats://demo.nats.io" });
    expect(account.senderIdentity).toBe("off");
    expect(account.minSenderTrust).toBe("any");
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

describe("identity env overrides (SYNADIA_* convention)", () => {
  let savedIdentity: Record<string, string | undefined>;
  beforeEach(() => {
    savedIdentity = snapshotIdentityEnv();
  });
  afterEach(() => {
    restoreIdentityEnv(savedIdentity);
  });

  const cfg = {
    channels: {
      nats: {
        accounts: {
          default: {
            agentName: "cfg-name",
            owner: "cfg-owner",
            credentials: "/cfg.creds",
          },
        },
      },
    },
  };

  it("SYNADIA_OPENCLAW_OWNER (per-agent) wins over fleet-wide, legacy, and config", () => {
    process.env.SYNADIA_OPENCLAW_OWNER = "per-agent";
    process.env.SYNADIA_OWNER = "fleet";
    process.env.NATS_OWNER = "legacy";
    expect(resolveNatsAccount(cfg, "default").owner).toBe("per-agent");
  });

  it("SYNADIA_OWNER (fleet-wide) wins over the legacy vars and config", () => {
    process.env.SYNADIA_OWNER = "fleet";
    process.env.NATS_OWNER = "legacy";
    process.env.NATS_ORG = "older";
    expect(resolveNatsAccount(cfg, "default").owner).toBe("fleet");
  });

  it("legacy NATS_OWNER and NATS_ORG keep working below the SYNADIA_* vars", () => {
    process.env.NATS_OWNER = "legacy";
    expect(resolveNatsAccount(cfg, "default").owner).toBe("legacy");
    delete process.env.NATS_OWNER;
    process.env.NATS_ORG = "older";
    expect(resolveNatsAccount(cfg, "default").owner).toBe("older");
  });

  it("agentName: SYNADIA_OPENCLAW_NAME > SYNADIA_NAME > NATS_AGENT_NAME > config", () => {
    expect(resolveNatsAccount(cfg, "default").agentName).toBe("cfg-name");
    process.env.NATS_AGENT_NAME = "legacy-name";
    expect(resolveNatsAccount(cfg, "default").agentName).toBe("legacy-name");
    process.env.SYNADIA_NAME = "fleet-name";
    expect(resolveNatsAccount(cfg, "default").agentName).toBe("fleet-name");
    process.env.SYNADIA_OPENCLAW_NAME = "per-agent-name";
    expect(resolveNatsAccount(cfg, "default").agentName).toBe("per-agent-name");
  });

  it("NATS_CREDS is accepted as an alias when NATS_CREDENTIALS is unset", () => {
    process.env.NATS_CREDS = "/alias.creds";
    expect(resolveNatsAccount(cfg, "default").credentials).toBe("/alias.creds");
  });

  it("NATS_CREDENTIALS (incumbent) wins when both creds vars are set", () => {
    process.env.NATS_CREDENTIALS = "/incumbent.creds";
    process.env.NATS_CREDS = "/alias.creds";
    expect(resolveNatsAccount(cfg, "default").credentials).toBe(
      "/incumbent.creds",
    );
  });
});

describe("atomic connection source resolution", () => {
  let savedEnvUrl: string | undefined;
  let savedEnvCtx: string | undefined;
  let savedIdentity: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnvUrl = process.env.NATS_URL;
    savedEnvCtx = process.env.NATS_CONTEXT;
    // Also clears NATS_CREDENTIALS / NATS_CREDS, which these tests assert on.
    savedIdentity = snapshotIdentityEnv();
    delete process.env.NATS_URL;
    delete process.env.NATS_CONTEXT;
  });

  afterEach(() => {
    if (savedEnvUrl === undefined) delete process.env.NATS_URL;
    else process.env.NATS_URL = savedEnvUrl;
    if (savedEnvCtx === undefined) delete process.env.NATS_CONTEXT;
    else process.env.NATS_CONTEXT = savedEnvCtx;
    restoreIdentityEnv(savedIdentity);
  });

  it("passes config.context intact to the shared bundle helper", () => {
    const cfg = {
      channels: {
        nats: {
          accounts: {
            default: {
              agentName: "x",
              context: "ngs",
              url: "nats://ignored:4222",
              credentials: "/ignored.creds",
            },
          },
        },
      },
    };
    const acct = resolveNatsAccount(cfg, "default");
    expect(acct.connectionSource).toEqual({ context: "ngs" });
  });

  it("a direct URL env override selects the direct source atomically", () => {
    process.env.NATS_URL = "nats://override.example.com:4222";
    const cfg = {
      channels: {
        nats: {
          accounts: {
            default: {
              agentName: "x",
              context: "ngs",
              credentials: "/direct.creds",
            },
          },
        },
      },
    };
    const acct = resolveNatsAccount(cfg, "default");
    expect(acct.connectionSource).toEqual({
      url: "nats://override.example.com:4222",
      creds: "/direct.creds",
    });
  });

  it("a credentials env override selects the direct source with the configured URL", () => {
    process.env.NATS_CREDENTIALS = "/from-env.creds";
    const cfg = {
      channels: {
        nats: {
          accounts: {
            default: {
              agentName: "x",
              context: "ngs",
              url: "tls://direct.example:4222",
            },
          },
        },
      },
    };
    const acct = resolveNatsAccount(cfg, "default");
    expect(acct.connectionSource).toEqual({
      url: "tls://direct.example:4222",
      creds: "/from-env.creds",
    });
  });

  it("$NATS_CONTEXT wins as one complete source", () => {
    process.env.NATS_CONTEXT = "env-ctx";
    process.env.NATS_URL = "nats://ignored:4222";
    process.env.NATS_CREDENTIALS = "/ignored.creds";
    const cfg = {
      channels: {
        nats: {
          accounts: { default: { agentName: "x", context: "wizard-ctx" } },
        },
      },
    };
    const acct = resolveNatsAccount(cfg, "default");
    expect(acct.connectionSource).toEqual({ context: "env-ctx" });
  });
});

describe("sender identity and inbound trust", () => {
  let savedIdentity: Record<string, string | undefined>;
  beforeEach(() => {
    savedIdentity = snapshotIdentityEnv();
  });
  afterEach(() => {
    restoreIdentityEnv(savedIdentity);
  });

  it("keeps outgoing identity and incoming trust independent", () => {
    const signedHost = resolveNatsAccount({
      channels: {
        nats: {
          accounts: {
            default: {
              agentName: "x",
              senderIdentity: "signed",
              minSenderTrust: "any",
            },
          },
        },
      },
    });
    expect(signedHost.senderIdentity).toBe("signed");
    expect(signedHost.minSenderTrust).toBe("any");

    const strictUnsignedHost = resolveNatsAccount({
      channels: {
        nats: {
          accounts: {
            default: {
              agentName: "x",
              senderIdentity: "off",
              minSenderTrust: "signed",
            },
          },
        },
      },
    });
    expect(strictUnsignedHost.senderIdentity).toBe("off");
    expect(strictUnsignedHost.minSenderTrust).toBe("signed");
  });

  it("lets the standardized env vars override account config", () => {
    process.env.NATS_SENDER_IDENTITY = "signed";
    process.env.NATS_MIN_SENDER_TRUST = "signed";
    const account = resolveNatsAccount({
      channels: {
        nats: {
          accounts: {
            default: {
              agentName: "x",
              senderIdentity: "off",
              minSenderTrust: "any",
            },
          },
        },
      },
    });
    expect(account.senderIdentity).toBe("signed");
    expect(account.minSenderTrust).toBe("signed");
  });

  it("fails fast on invalid modes", () => {
    expect(() =>
      resolveNatsAccount({
        channels: {
          nats: {
            accounts: {
              default: {
                agentName: "x",
                senderIdentity: "sometimes",
              },
            },
          },
        },
      } as never),
    ).toThrow('senderIdentity must be "off" or "signed"');
    process.env.NATS_MIN_SENDER_TRUST = "friends";
    expect(() => resolveNatsAccount({})).toThrow(
      'NATS_MIN_SENDER_TRUST must be "any" or "signed"',
    );
  });
});
