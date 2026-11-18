import { describe, expect, test } from "bun:test";

import { REMOTE_SOURCE, joinOptions, withRemoteProvenance, type SendOptions } from "../src/host.js";

describe("joinOptions", () => {
  const tools = [{ name: "discover_agents" }];
  const onPermissionRequest = () => ({ kind: "no-result" });

  test("modern hosts get tools.definitions and permissions.onRequest", () => {
    const out = joinOptions("modern", { tools, requestedEnvironmentVariables: ["NATS_CREDS"], onPermissionRequest });
    expect(out).toEqual({
      tools: { definitions: tools },
      permissions: { onRequest: onPermissionRequest },
      requestedEnvironmentVariables: ["NATS_CREDS"],
    });
  });

  test("legacy hosts get a tool array and onPermissionRequest", () => {
    const out = joinOptions("legacy", { tools, onPermissionRequest });
    expect(out).toEqual({ tools, onPermissionRequest });
  });

  test("no permission handler unless one is given", () => {
    expect(joinOptions("modern", { tools })).toEqual({ tools: { definitions: tools } });
    expect(joinOptions("legacy", {})).toEqual({});
  });
});

describe("withRemoteProvenance", () => {
  test("tags sends as agent-sourced and keeps other members bound", async () => {
    const sent: unknown[] = [];
    const session = {
      sessionId: "s1",
      send: async (options: SendOptions) => {
        sent.push(options);
        return "m1";
      },
      on(this: { sessionId: string }) {
        return this.sessionId;
      },
    };
    const wrapped = withRemoteProvenance(session);
    expect(await wrapped.send({ prompt: "hi" })).toBe("m1");
    expect(sent).toEqual([{ prompt: "hi", source: REMOTE_SOURCE }]);
    expect(wrapped.on()).toBe("s1");
    expect(wrapped.sessionId).toBe("s1");
  });

  test("falls back to untagged sends once the host rejects the field", async () => {
    const sent: unknown[] = [];
    const fallbacks: unknown[] = [];
    const session = {
      send: async (options: SendOptions & { source?: string }) => {
        if (options.source) throw new Error("unknown field source");
        sent.push(options);
        return `m${sent.length}`;
      },
    };
    const wrapped = withRemoteProvenance(session, (e) => fallbacks.push(e));
    expect(await wrapped.send({ prompt: "a" })).toBe("m1");
    expect(await wrapped.send({ prompt: "b" })).toBe("m2");
    expect(sent).toEqual([{ prompt: "a" }, { prompt: "b" }]);
    expect(fallbacks).toHaveLength(1);
  });
});
