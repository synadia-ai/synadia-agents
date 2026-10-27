// The channel's `transformReplyPayload`: OpenClaw shows it a reply's
// `isError`, which the payload `deliver` gets has lost; the transform
// copies it to `channelData.nats.isError`. OpenClaw's plugin helpers and
// the gateway are mocked; the plugin object is the one `channel.ts` builds.

import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/core", () => ({
  // As OpenClaw's helper does: the base's surfaces at the top.
  createChatChannelPlugin: (params: { base: Record<string, unknown> }) => ({ ...params.base }),
  buildChannelOutboundSessionRoute: vi.fn(),
  DEFAULT_ACCOUNT_ID: "default",
}));
vi.mock("./gateway.js", () => ({
  startNatsGateway: vi.fn(),
  stopNatsGateway: vi.fn(),
}));
vi.mock("./runtime.js", () => ({
  getActiveConnection: () => null,
  getActiveAgentName: () => null,
  getActiveExtensions: () => null,
  getActiveOwner: () => null,
}));

import { natsPlugin } from "./channel.js";
import { isFailedRunReply } from "./failed-run.js";

type Payload = { text?: string; isError?: boolean; channelData?: Record<string, unknown> };

const transform = (
  natsPlugin as unknown as {
    messaging: { transformReplyPayload: (params: { payload: Payload; cfg: unknown }) => Payload | null };
  }
).messaging.transformReplyPayload;

describe("the channel's transformReplyPayload", () => {
  it("marks a payload OpenClaw flagged as an error, and keeps the rest of channelData", () => {
    const payload: Payload = {
      text: "⚠️ Agent run failed.",
      isError: true,
      channelData: { other: { kept: 1 }, nats: { note: "kept" } },
    };
    const out = transform({ payload, cfg: {} });
    expect(out).toEqual({
      text: "⚠️ Agent run failed.",
      isError: true,
      channelData: { other: { kept: 1 }, nats: { note: "kept", isError: true } },
    });
    expect(isFailedRunReply(out!)).toBe(true);
    // The input is not changed.
    expect(payload.channelData).toEqual({ other: { kept: 1 }, nats: { note: "kept" } });
  });

  it("marks one without channelData", () => {
    const out = transform({ payload: { text: "failed", isError: true }, cfg: {} });
    expect(out).toEqual({ text: "failed", isError: true, channelData: { nats: { isError: true } } });
  });

  it("returns any other payload as it is, never null", () => {
    for (const payload of [
      { text: "hello" },
      { text: "hello", isError: false },
      { text: "", channelData: { other: true } },
      {},
    ] as Payload[]) {
      const out = transform({ payload, cfg: {} });
      expect(out).not.toBeNull();
      expect(out).toBe(payload);
      expect(isFailedRunReply(out!)).toBe(false);
    }
  });
});
