// The runs no NATS prompt started (see `extensions/local-turns.ts`): when
// a local turn opens and closes at PI's events, and what the provider
// headers and the agent tools are given meanwhile. The channel's own
// wiring of these events is exercised by `test/smoke.mjs`.
//
// Run with: bun test test/local-turns.test.ts

import { describe, expect, test } from "bun:test";
import type { PromptResponse } from "@synadia-ai/agent-service";
import { LOCAL_TURN_PREFIX, PiLocalTurns } from "../extensions/local-turns.ts";
import { PiPromptQueue } from "../extensions/prompt-queue.ts";

const response = {} as PromptResponse;

function setup(): { queue: PiPromptQueue; turns: PiLocalTurns } {
	const queue = new PiPromptQueue();
	return { queue, turns: new PiLocalTurns(() => queue.active?.served) };
}

describe("PiLocalTurns", () => {
	test("agent_start with no NATS prompt active opens a local turn", () => {
		const { turns } = setup();
		expect(turns.open).toBeUndefined();
		const turn = turns.start();
		expect(turn).toEqual({ id: "local-1", local: true });
		expect(Object.isFrozen(turn)).toBe(true);
		expect(turns.open).toBe(turn);
	});

	test("agent_start of a NATS prompt's run opens none: the queue marks the prompt active before the hand-over", async () => {
		const { queue, turns } = setup();
		const request = queue.enqueue({ prompt: "from NATS" }, response);
		expect(queue.takeNext()).toBe(request);
		expect(turns.start()).toBeUndefined();
		expect(turns.open).toBeUndefined();
		expect(turns.current()).toBe(request.served);
		queue.completeActive();
		await request.completion;
	});

	test("a run that starts again (agent.continue) stays one turn", () => {
		const { turns } = setup();
		const turn = turns.start();
		expect(turns.start()).toBeUndefined();
		expect(turns.start()).toBeUndefined();
		expect(turns.open).toBe(turn);
	});

	test("agent_settled closes the turn and returns it, once; the next run is a turn of its own", () => {
		const { turns } = setup();
		const first = turns.start()!;
		expect(turns.end()).toBe(first);
		expect(turns.open).toBeUndefined();
		expect(turns.end()).toBeUndefined();
		const second = turns.start()!;
		expect(second.id).toBe("local-2");
		expect(second.id).not.toBe(first.id);
	});

	test("closed at agent_settled before the drain, the next NATS prompt's run opens no local turn", async () => {
		const { queue, turns } = setup();
		const local = turns.start()!;
		// A NATS prompt arrives while the local turn runs, and waits.
		const queued = queue.enqueue({ prompt: "waits" }, response);
		// agent_settled: the local turn closes first, then the queue drains.
		expect(turns.end()).toBe(local);
		expect(queue.takeNext()).toBe(queued);
		// The injected run's agent_start sees its prompt active.
		expect(turns.start()).toBeUndefined();
		expect(turns.current()).toBe(queued.served);
		queue.completeActive();
		await queued.completion;
	});

	test("the header and tool hooks are given the local turn while it is open, and nothing after", () => {
		const { turns } = setup();
		expect(turns.current()).toBeUndefined();
		const turn = turns.start()!;
		expect(turns.current()).toBe(turn);
		turns.end();
		expect(turns.current()).toBeUndefined();
	});

	test("a NATS prompt active wins over an open local turn", async () => {
		// Not reached through the channel, which hands PI a queued prompt only
		// once the local turn has closed; the rule still names one turn.
		const { queue, turns } = setup();
		turns.start();
		const request = queue.enqueue({ prompt: "x" }, response);
		queue.takeNext();
		expect(turns.current()).toBe(request.served);
		queue.completeActive();
		await request.completion;
	});

	test("the session's end closes an open turn; with none open it closes nothing", () => {
		const { turns } = setup();
		expect(turns.end()).toBeUndefined();
		const turn = turns.start();
		expect(turns.end()).toBe(turn);
		expect(turns.open).toBeUndefined();
	});

	test("a local turn's id never equals a request id: requests are numbered, turns prefixed", () => {
		const { queue, turns } = setup();
		const request = queue.enqueue({ prompt: "x" }, response);
		expect(request.id).toMatch(/^\d+$/);
		const turn = turns.start()!;
		expect(turn.id.startsWith(LOCAL_TURN_PREFIX)).toBe(true);
		expect(turn.id).not.toBe(request.id);
		void request.completion.catch(() => undefined);
		queue.failAll("done");
	});
});
