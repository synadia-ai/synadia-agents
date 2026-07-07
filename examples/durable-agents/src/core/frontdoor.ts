// core/frontdoor.ts — the AgentService front-door. A thin, NON-durable relay: it dispatches the
// durable agent run over NATS, streams coarse progress, and bridges each parked approval to a §7
// query (the human answers in chat), routing the reply to `resonate.promises.resolve`.
//
// The durable brain is the source of truth. This process can die and restart without losing the
// run — which is exactly why the front-door is deliberately NOT durable: session/transport is
// ephemeral, the agent's reasoning + effects are journaled.
import type { NatsConnection } from "@nats-io/transport-node";
import { Codec, type Resonate } from "@resonatehq/sdk";
import { AgentService } from "@synadia-ai/agent-service";
import type { AgentResult } from "./effects";

/** Subject a parked approval is announced on, so the front-door can raise an in-chat query. */
export const approvalSubject = (runId: string): string => `de-agent.approval.${runId}`;

export interface ServeConfig {
  nc: NatsConnection;
  /** Instance that has the durable workflow registered (acts as both worker and dispatcher). */
  resonate: Resonate;
  /** Name of the registered durable workflow; it takes `{ prompt }` and returns an AgentResult. */
  workflowName: string;
  agent: string; // agent type token, e.g. "durable-sre"
  owner: string;
  name: string;
  description: string;
  approvalTimeoutMs?: number;
}

export async function serveAgent(cfg: ServeConfig): Promise<AgentService> {
  const codec = new Codec();
  const service = new AgentService({
    nc: cfg.nc,
    agent: cfg.agent,
    owner: cfg.owner,
    name: cfg.name,
    description: cfg.description,
    version: "0.0.0",
    heartbeatIntervalS: 10,
    keepaliveIntervalS: null, // we send our own status lines
  });

  let seq = 0;
  service.onPrompt(async (envelope, response) => {
    // Dotless: in Resonate a dot denotes lineage (parent.child), so a root run id must not contain one.
    const runId = `${cfg.agent}-${service.instanceId}-${++seq}`;
    await response.send({ type: "status", status: "ack" });
    await response.send({ type: "status", status: `▶ durable run \`${runId}\`` });

    // Bridge: a parked approval (announced by the workflow) → an in-chat §7 query → resolve the
    // durable promise. The gate itself lives in the journal, so this is just the live "face".
    const sub = cfg.nc.subscribe(approvalSubject(runId), {
      callback: (err, msg) => {
        if (err) return;
        void (async () => {
          const { promiseId, ask } = JSON.parse(msg.string()) as {
            awaitName: string;
            promiseId: string;
            ask?: { name?: string; args?: unknown };
          };
          let approved = false;
          try {
            const reply = await response.ask(
              `⏸ Approve \`${ask?.name}(${JSON.stringify(ask?.args ?? {})})\`? (yes/no)`,
              { timeoutMs: cfg.approvalTimeoutMs ?? 5 * 60_000 },
            );
            approved = /^\s*(y|yes|approve|allow|ok|true)\b/i.test(reply.prompt ?? "");
          } catch {
            approved = false; // timeout ⇒ deny
          }
          await cfg.resonate.promises.resolve(promiseId, codec.encode({ approved }));
          await response.send({ type: "status", status: approved ? "✅ approved" : "🚫 denied" });
        })();
      },
    });

    try {
      const handle = await cfg.resonate.beginRun(runId, cfg.workflowName, { prompt: envelope.prompt });
      const result = (await handle.result()) as AgentResult;
      await response.send(result.answer);
    } catch (err) {
      await response.send(`\n[agent error] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sub.unsubscribe();
    }
  });

  await service.start();
  return service;
}
