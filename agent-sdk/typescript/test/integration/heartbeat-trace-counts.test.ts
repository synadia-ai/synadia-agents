import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import {
  countTraceRecordDropped,
  countTraceRecordPublished,
  decodeHeartbeatPayload,
  traceRecordCounts,
  type HeartbeatPayload,
  type TraceOptions,
} from "@synadia-ai/agents";
import { AgentService } from "../../src/service.js";

const natsUrl = inject("natsUrl");

/**
 * A service that opted in to tracing reports how many trace records its
 * process has published and dropped since it started, as
 * `records_published` and `records_dropped` on every heartbeat and on
 * the status reply — so whoever consumes the heartbeat knows how many
 * records the process failed to publish. An untraced service reports
 * neither: its heartbeat stays byte-identical to plain protocol 0.3.
 */
describe.skipIf(!natsUrl)("heartbeat trace record counts", () => {
  let nc: NatsConnection;
  beforeAll(async () => {
    nc = await connect({ servers: natsUrl! });
  });
  afterAll(async () => {
    await nc.close();
  });

  async function firstHeartbeatAndStatus(
    trace: TraceOptions | undefined,
    agent: string,
    betweenBeatAndStatus: () => void = () => undefined,
  ): Promise<{ heartbeat: HeartbeatPayload; status: HeartbeatPayload }> {
    const svc = new AgentService({
      nc,
      agent,
      owner: "p",
      name: `${agent}-1`,
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      ...(trace !== undefined ? { trace } : {}),
    });
    svc.onPrompt(async (_e, r) => {
      await r.send("ok");
    });
    const sub = nc.subscribe(svc.subject.heartbeat);
    await nc.flush();
    await svc.start();
    try {
      const first = await (async () => {
        for await (const m of sub) return m;
        throw new Error("heartbeat subscription closed");
      })();
      const heartbeat = decodeHeartbeatPayload(JSON.parse(new TextDecoder().decode(first.data)));
      betweenBeatAndStatus();
      const reply = await nc.request(svc.subject.status, new Uint8Array(0), { timeout: 2000 });
      const status = decodeHeartbeatPayload(JSON.parse(new TextDecoder().decode(reply.data)));
      if (!heartbeat || !status) throw new Error("malformed heartbeat payload");
      return { heartbeat, status };
    } finally {
      sub.unsubscribe();
      await svc.stop();
    }
  }

  it("carries the process-wide counts when the service opted in", async () => {
    // The counters are process-wide and cumulative; move both so the
    // heartbeat provably reads them rather than a constant.
    countTraceRecordPublished();
    countTraceRecordDropped();
    const expected = traceRecordCounts();
    const { heartbeat, status } = await firstHeartbeatAndStatus({}, "hb-traced");
    for (const payload of [heartbeat, status]) {
      expect(payload.extras["records_published"]).toBe(expected.published);
      expect(payload.extras["records_dropped"]).toBe(expected.dropped);
    }
  });

  it("reads the counts fresh on every beat", async () => {
    // One service: a drop counted after its first heartbeat shows on the
    // status reply that follows.
    const { heartbeat, status } = await firstHeartbeatAndStatus({}, "hb-fresh", () =>
      countTraceRecordDropped(),
    );
    expect(status.extras["records_dropped"]).toBe(
      (heartbeat.extras["records_dropped"] as number) + 1,
    );
  });

  it("carries neither count when nothing opted in", async () => {
    const { heartbeat, status } = await firstHeartbeatAndStatus(undefined, "hb-untraced");
    for (const payload of [heartbeat, status]) {
      expect(payload.extras).toEqual({});
    }
  });

  it("carries neither count in propagate-only mode, which publishes no records", async () => {
    const { heartbeat, status } = await firstHeartbeatAndStatus(
      { edgeSubject: null },
      "hb-propagate",
    );
    for (const payload of [heartbeat, status]) {
      expect(payload.extras).toEqual({});
    }
  });
});
