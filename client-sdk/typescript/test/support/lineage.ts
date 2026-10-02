// A small, generic lineage extension built on nothing but the SDKs' public
// hooks — test support, not SDK code. It exists to prove the hooks can
// carry an extension that needs every one of them:
//
//   - the caller side (a `PromptInterceptor`) mints a node id per prompt
//     and inherits root and parent from the ambient scope in its first
//     phase, which adds the node and root to the envelope as two extra
//     fields; its second phase — once the prompt is signed and certain to
//     go out — publishes one signed record about it, whose id is the
//     header's nonce and the `Nats-Msg-Id`;
//   - the host side (a `RequestInterceptor`) reads those fields back,
//     refuses a half pair with `400`, mints a root when there is none, and
//     runs the handler inside the scope, so a client used inside the
//     handler inherits it;
//   - `heartbeatExtras` reports how many records were published and
//     dropped, on every heartbeat and status reply.
//
// The field and header names are this module's own; the SDK knows none of
// them.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { RequestInterceptor } from "@synadia-ai/agent-service";
import { ProtocolError, type PromptInterceptor } from "../../src/index.js";

/** The envelope fields and the header the pair adds. */
export const NODE_FIELD = "lineage_node";
export const ROOT_FIELD = "lineage_root";
export const NODE_HEADER = "Lineage-Node";

/** One execution: its own node id and the id of its tree's root. */
export interface LineageScope {
  readonly node: string;
  readonly root: string;
}

/** The record the caller side publishes before each prompt. */
export interface LineageRecord {
  readonly record_id: string;
  readonly agent: string;
  readonly node: string;
  readonly parent: string | null;
  readonly root: string;
  readonly target: string;
  readonly label: string | null;
}

/** What phase one decides about the record phase two publishes. */
interface PlannedRecord {
  readonly node: string;
  readonly parent: string | null;
  readonly root: string;
  readonly label: string | null;
}

export interface LineageCounts {
  published: number;
  dropped: number;
  adopted: number;
  minted: number;
}

export interface Lineage {
  readonly caller: PromptInterceptor;
  readonly host: RequestInterceptor;
  readonly heartbeatExtras: () => Readonly<Record<string, unknown>>;
  /** The scope bound around the running handler, if any. */
  current(): LineageScope | undefined;
  /** Run `fn` inside `scope`, as the host side does around a handler. */
  within<T>(scope: LineageScope, fn: () => T): T;
  readonly counts: Readonly<LineageCounts>;
}

const ID = /^[0-9a-f]{32}$/;

function newId(): string {
  return randomBytes(16).toString("hex");
}

/** One lineage extension publishing its records to `recordSubject`. */
export function lineage(recordSubject: string): Lineage {
  const storage = new AsyncLocalStorage<LineageScope>();
  const counts: LineageCounts = { published: 0, dropped: 0, adopted: 0, minted: 0 };

  const caller: PromptInterceptor = {
    // Phase one decides everything and publishes nothing: the prompt may
    // still fail its size check or its identity at publish time.
    beforePrompt(ctx) {
      const ambient = storage.getStore();
      const node = newId();
      const root = ambient?.root ?? node;
      const label = ctx.context["label"];
      const planned: PlannedRecord = {
        node,
        parent: ambient?.node ?? null,
        root,
        label: typeof label === "string" ? label : null,
      };
      return {
        fields: { [NODE_FIELD]: node, [ROOT_FIELD]: root },
        headers: { [NODE_HEADER]: node },
        state: planned,
      };
    },
    // Phase two runs only for a prompt that goes out, immediately before
    // it: the record describes a prompt that was sent.
    async beforePublish(ctx, extras) {
      const planned = extras?.state as PlannedRecord;
      if (!ctx.identity.canSign) {
        // Readers ignore unsigned records: the record is owed and dropped.
        counts.dropped += 1;
        return;
      }
      try {
        const recordId = newId();
        const record: LineageRecord = {
          record_id: recordId,
          agent: await ctx.identity.selfId(),
          ...planned,
          target: ctx.agent.instanceId,
        };
        await ctx.identity.publishSigned(recordSubject, JSON.stringify(record), {
          nonce: recordId,
        });
        counts.published += 1;
      } catch {
        counts.dropped += 1;
      }
    },
  };

  const host: RequestInterceptor = {
    async aroundRequest(ctx, next) {
      const extras = ctx.envelope.extras ?? {};
      const node = extras[NODE_FIELD];
      const root = extras[ROOT_FIELD];
      if ((node === undefined) !== (root === undefined)) {
        throw new ProtocolError(`${NODE_FIELD} and ${ROOT_FIELD} must be given together`);
      }
      let scope: LineageScope;
      if (node !== undefined) {
        if (
          typeof node !== "string" ||
          typeof root !== "string" ||
          !ID.test(node) ||
          !ID.test(root)
        ) {
          throw new ProtocolError(
            `${NODE_FIELD} and ${ROOT_FIELD} must be 32 lowercase hex characters`,
          );
        }
        scope = { node, root };
        counts.adopted += 1;
      } else {
        const minted = newId();
        scope = { node: minted, root: minted };
        counts.minted += 1;
      }
      await storage.run(scope, next);
    },
  };

  return {
    caller,
    host,
    heartbeatExtras: () => ({
      lineage_published: counts.published,
      lineage_dropped: counts.dropped,
    }),
    current: () => storage.getStore(),
    within: (scope, fn) => storage.run(scope, fn),
    counts,
  };
}
