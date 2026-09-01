import { describe, expect, test } from "bun:test";
import type { PromptResponse } from "@synadia-ai/agent-service";
import { PiPromptQueue } from "../extensions/prompt-queue.ts";

const response = {} as PromptResponse;

describe("PiPromptQueue", () => {
	test("keeps deferred handlers open until their PI turns end", async () => {
		const queue = new PiPromptQueue();
		const first = queue.enqueue({ prompt: "one" }, response, 10);
		const second = queue.enqueue({ prompt: "two" }, response, 20);
		let firstSettled = false;
		first.completion.finally(() => {
			firstSettled = true;
		});

		expect(queue.takeNext()?.id).toBe(first.id);
		await Promise.resolve();
		expect(firstSettled).toBe(false);
		expect(queue.takeNext()).toBeUndefined();

		queue.completeActive();
		await first.completion;
		expect(firstSettled).toBe(true);
		expect(queue.takeNext()?.id).toBe(second.id);
		queue.completeActive();
		await second.completion;
	});

	test("expiration rejects queued requests but never the active turn", async () => {
		const queue = new PiPromptQueue();
		const active = queue.enqueue({ prompt: "active" }, response, 1);
		const stale = queue.enqueue({ prompt: "stale" }, response, 2);
		const staleResult = stale.completion.catch((error: Error) => error.message);
		queue.takeNext();

		expect(queue.expireQueued(3)).toBe(1);
		expect(await staleResult).toMatch(/expired/);
		expect(queue.active?.id).toBe(active.id);

		queue.completeActive();
		await active.completion;
	});

	test("shutdown rejects active and queued handlers exactly once", async () => {
		const queue = new PiPromptQueue();
		const active = queue.enqueue({ prompt: "active" }, response);
		const queued = queue.enqueue({ prompt: "queued" }, response);
		const results = Promise.all([
			active.completion.catch((error: Error) => error.message),
			queued.completion.catch((error: Error) => error.message),
		]);
		queue.takeNext();

		expect(queue.failAll("shutdown")).toBe(2);
		expect(queue.failAll("again")).toBe(0);
		expect(await results).toEqual(["shutdown", "shutdown"]);
		expect(queue.size).toBe(0);
		expect(queue.active).toBeUndefined();
	});

	test("a temporary PI injection refusal can be requeued", async () => {
		const queue = new PiPromptQueue();
		const request = queue.enqueue({ prompt: "retry" }, response);
		expect(queue.takeNext()?.id).toBe(request.id);
		queue.requeueActive();
		expect(queue.active).toBeUndefined();
		expect(queue.takeNext()?.id).toBe(request.id);
		queue.completeActive();
		await request.completion;
	});
});
