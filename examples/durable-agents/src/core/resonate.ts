// core/resonate.ts — the RESONATE driver. This is the ONLY Resonate-aware code in the whole suite:
// ~15 lines that make the engine-neutral agent loop durable on Resonate. It steps the loop and, for
// each yielded Effect, performs the matching Resonate op via `yield*` so Resonate journals + replays
// it. Writing an adapter for a different DE framework means writing one more file shaped like this.
import type { Context } from "@resonatehq/sdk";
import type { AgentResult, Effect } from "./effects";

/** How a parked approval reaches the outside world (publish the await id so a human can answer). */
export type Notify = (awaitName: string, promiseId: string, ask: unknown) => void | Promise<void>;

export function* driveResonate(
  ctx: Context,
  loop: Generator<Effect, AgentResult, any>,
  notify: Notify,
  /** Optional observability hook, fired after a step's result is journaled (used by the crash demo). */
  hooks?: { afterStep?: (name: string) => void },
): Generator<any, AgentResult, any> {
  let fed: any = undefined;
  for (;;) {
    const { value, done } = loop.next(fed);
    if (done) return value as AgentResult;
    const eff = value as Effect;
    if (eff.t === "step") {
      // Durable step (LLM or tool). `eff.name` is our stable idempotency key for the side effect.
      fed = yield* ctx.run(() => eff.run(eff.name));
      hooks?.afterStep?.(eff.name); // step-end is journaled by the time ctx.run returns
    } else {
      // Durable approval: create a promise, publish its id, then park until someone resolves it.
      const p = yield* ctx.promise<{ approved: boolean }>();
      yield* ctx.run(() => notify(eff.name, p.id, eff.ask));
      fed = yield* p;
    }
  }
}
