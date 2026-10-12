// The config bootstrap: the default account skeleton is written only when
// neither the config nor the environment names the agent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createNatsConfigBootstrap } from "./bootstrap.js";

const NAME_VARS = ["SYNADIA_OPENCLAW_NAME", "SYNADIA_NAME", "NATS_AGENT_NAME"] as const;

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

  it("writes the default account skeleton when neither config nor env names the agent", async () => {
    const { runtime, mutateConfigFile, written } = fakeRuntime({});
    createNatsConfigBootstrap()(runtime);
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(written[0]).toEqual({ channels: { nats: { accounts: { default: {} } } } });
  });

  it("writes once when both plugin callbacks fire", async () => {
    const { runtime, mutateConfigFile } = fakeRuntime({});
    const ensure = createNatsConfigBootstrap();
    ensure(runtime);
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
