import { describe, expect, it, vi } from "vitest";
import type { NatsConnection } from "@nats-io/nats-core";
import { buildQueryEvent, QueryAlreadyRepliedError } from "../../src/query/query-event.js";

function makeMocks() {
  const publish = vi.fn<(subject: string, payload?: unknown) => void>();
  const flush = vi.fn(() => Promise.resolve());
  const nc = { publish, flush } as unknown as NatsConnection;
  return { nc, publish, flush };
}

describe("buildQueryEvent", () => {
  it("carries the decoded fields verbatim", () => {
    const { nc } = makeMocks();
    const evt = buildQueryEvent(nc, {
      id: "q-1",
      replySubject: "_INBOX.x",
      prompt: "Continue?",
      attachments: [{ filename: "a.png", content: "AA==" }],
    });
    expect(evt.type).toBe("query");
    expect(evt.id).toBe("q-1");
    expect(evt.prompt).toBe("Continue?");
    expect(evt.attachments).toEqual([{ filename: "a.png", content: "AA==" }]);
  });

  it("publishes a plain-text reply to the reply_subject", async () => {
    const { nc, publish } = makeMocks();
    const evt = buildQueryEvent(nc, { id: "q-1", replySubject: "_INBOX.x", prompt: "?" });
    await evt.reply("yes");
    expect(publish).toHaveBeenCalledOnce();
    const [subject, payload] = publish.mock.calls[0]!;
    expect(subject).toBe("_INBOX.x");
    expect(new TextDecoder().decode(payload as Uint8Array)).toBe("yes");
  });

  it("publishes a JSON envelope reply when given an object", async () => {
    const { nc, publish } = makeMocks();
    const evt = buildQueryEvent(nc, { id: "q-1", replySubject: "_INBOX.x", prompt: "?" });
    await evt.reply({ prompt: "yes please" });
    const [, payload] = publish.mock.calls[0]!;
    const parsed = JSON.parse(new TextDecoder().decode(payload as Uint8Array)) as {
      prompt: string;
    };
    expect(parsed).toEqual({ prompt: "yes please" });
  });

  it("second reply throws QueryAlreadyRepliedError", async () => {
    const { nc, publish } = makeMocks();
    const evt = buildQueryEvent(nc, { id: "q-dup", replySubject: "_INBOX.x", prompt: "?" });
    await evt.reply("yes");
    await expect(evt.reply("no")).rejects.toBeInstanceOf(QueryAlreadyRepliedError);
    // The NC should still only have been called once.
    expect(publish).toHaveBeenCalledOnce();
  });
});
