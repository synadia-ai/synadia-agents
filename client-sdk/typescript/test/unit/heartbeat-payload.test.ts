import { describe, expect, it } from "vitest";
import { decodeHeartbeatPayload } from "../../src/heartbeat/payload.js";

describe("decodeHeartbeatPayload", () => {
  it("decodes a spec §8.3 example payload", () => {
    const raw = {
      agent: "claude-code",
      owner: "aconnolly",
      session: "synadia-com-2",
      instance_id: "VMKS6MHK71PCPWGY38A7N5",
      ts: "2026-04-21T14:23:01Z",
      interval_s: 30,
    };
    const payload = decodeHeartbeatPayload(raw);
    expect(payload).not.toBeNull();
    expect(payload!.agent).toBe("claude-code");
    expect(payload!.owner).toBe("aconnolly");
    expect(payload!.session).toBe("synadia-com-2");
    expect(payload!.instanceId).toBe("VMKS6MHK71PCPWGY38A7N5");
    expect(payload!.ts).toBe("2026-04-21T14:23:01Z");
    expect(payload!.intervalS).toBe(30);
  });

  it("decodes without session (session-less agent)", () => {
    const raw = {
      agent: "openclaw",
      owner: "rene",
      instance_id: "abc",
      ts: "2026-04-21T14:23:01Z",
      interval_s: 30,
    };
    const payload = decodeHeartbeatPayload(raw);
    expect(payload).not.toBeNull();
    expect(payload!.session).toBeUndefined();
  });

  it("preserves unknown fields on the `extras` map (§12 forward-compat)", () => {
    const raw = {
      agent: "ccc",
      owner: "alice",
      instance_id: "abc",
      ts: "2026-04-21T14:23:01Z",
      interval_s: 30,
      future_field: "hello",
      region: "us-east-1",
    };
    const payload = decodeHeartbeatPayload(raw);
    expect(payload!.extras).toEqual({ future_field: "hello", region: "us-east-1" });
  });

  it.each([
    [null],
    [undefined],
    [42],
    ["string"],
    [[]],
    [{}],
    [{ agent: "a" }], // missing most fields
    [
      {
        agent: "a",
        owner: "b",
        instance_id: "c",
        ts: "t",
        interval_s: "30", // wrong type
      },
    ],
    [
      {
        agent: "a",
        owner: "b",
        instance_id: "c",
        ts: "t",
        interval_s: 0, // not > 0
      },
    ],
  ])("returns null for malformed input: %s", (input) => {
    expect(decodeHeartbeatPayload(input)).toBeNull();
  });
});
