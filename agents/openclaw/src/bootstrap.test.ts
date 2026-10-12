// The config bootstrap: no skeleton when the environment names the agent, a
// hint and no skeleton when nothing names it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createNatsConfigBootstrap } from "./bootstrap.js";

const NAME_VARS = ["SYNADIA_OPENCLAW_NAME", "SYNADIA_NAME", "NATS_AGENT_NAME"] as const;

// A config whose name is on an account other than the default: the one case
// in which the bootstrap still writes the skeleton.
const NAMED_ELSEWHERE = { channels: { nats: { accounts: { other: { agentName: "configured" } } } } };

function fakeRuntime(cfg: Record<string, unknown>) {
  const written: Record<string, unknown>[] = [];
  const mutateConfigFile = vi.fn(
    async (params: { mutate: (draft: Record<string, unknown>) => void }) => {
      const draft = structuredClone(cfg);
      params.mutate(draft);
      written.push(draft);
    },
  );
  const runtime = {
    config: { current: () => cfg, mutateConfigFile },
  } as unknown as PluginRuntime;
  return { runtime, mutateConfigFile, written };
}

describe("createNatsConfigBootstrap", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const v of NAME_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const v of NAME_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    vi.restoreAllMocks();
  });

  it("writes no skeleton when the environment names the agent", async () => {
    process.env.SYNADIA_OPENCLAW_NAME = "env-agent";
    const { runtime, mutateConfigFile } = fakeRuntime({});
    createNatsConfigBootstrap()(runtime);
    await Promise.resolve();
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(["SYNADIA_NAME", "NATS_AGENT_NAME"])(
    "writes no skeleton when %s names the agent",
    async (variable) => {
      process.env[variable] = "env-agent";
      const { runtime, mutateConfigFile } = fakeRuntime({});
      createNatsConfigBootstrap()(runtime);
      await Promise.resolve();
      expect(mutateConfigFile).not.toHaveBeenCalled();
    },
  );

  it("writes no skeleton and prints one hint when neither config nor env names the agent", async () => {
    const { runtime, mutateConfigFile } = fakeRuntime({});
    const ensure = createNatsConfigBootstrap();
    // Install time: setRuntime and registerFull both fire, no env loaded.
    ensure(runtime);
    ensure(runtime);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutateConfigFile).not.toHaveBeenCalled();
    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    const hints = logged.filter((line) => line.startsWith("[nats] agent name not set yet:"));
    expect(hints).toEqual([
      "[nats] agent name not set yet: it comes from SYNADIA_OPENCLAW_NAME, or channels.nats.accounts.default.agentName",
    ]);
    const all = [...logged, ...vi.mocked(console.warn).mock.calls.map((c) => String(c[0]))];
    expect(all.some((line) => line.includes("could not persist"))).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("writes the default account skeleton when only another configured account has a name", async () => {
    const { runtime, mutateConfigFile, written } = fakeRuntime({
      channels: { nats: { accounts: { other: { agentName: "configured" } } } },
    });
    createNatsConfigBootstrap()(runtime);
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(written[0]).toEqual({
      channels: { nats: { accounts: { other: { agentName: "configured" }, default: {} } } },
    });
  });

  it("writes once when both plugin callbacks fire", async () => {
    const { runtime, mutateConfigFile } = fakeRuntime(NAMED_ELSEWHERE);
    const ensure = createNatsConfigBootstrap();
    ensure(runtime);
    ensure(runtime);
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
  });

  it("retries on the second callback when the first cannot read the config", async () => {
    const { runtime, mutateConfigFile, written } = fakeRuntime(NAMED_ELSEWHERE);
    const config = (runtime as unknown as { config: { current: () => unknown } }).config;
    const current = config.current;
    config.current = () => {
      throw new Error("not ready");
    };
    const ensure = createNatsConfigBootstrap();
    ensure(runtime);
    expect(mutateConfigFile).not.toHaveBeenCalled();
    config.current = current;
    ensure(runtime);
    await vi.waitFor(() => expect(written).toHaveLength(1));
    ensure(runtime);
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the config already has the default account", () => {
    const { runtime, mutateConfigFile } = fakeRuntime({
      channels: { nats: { accounts: { default: { agentName: "configured" } } } },
    });
    createNatsConfigBootstrap()(runtime);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });
});
