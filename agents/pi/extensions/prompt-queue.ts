import type { RequestAttachment, RequestEnvelope } from "@synadia-ai/agents";
import type { PromptResponse } from "@synadia-ai/agent-service";

export interface QueuedPiPrompt {
	readonly id: string;
	readonly prompt: string;
	readonly attachments: ReadonlyArray<RequestAttachment>;
	readonly response: PromptResponse;
	readonly createdAt: number;
	readonly completion: Promise<void>;
}

interface MutableQueuedPiPrompt extends QueuedPiPrompt {
	settled: boolean;
	resolve(): void;
	reject(error: Error): void;
}

/**
 * Bridges AgentService's request-scoped async handler to PI's event-driven
 * lifecycle. A prompt handler returns `completion`; PI settles it on
 * `agent_end`, expiration, or shutdown. AgentService therefore keeps owning
 * admission, acknowledgements, keep-alives, errors, and the final terminator.
 */
export class PiPromptQueue {
	readonly #pending = new Map<string, MutableQueuedPiPrompt>();
	readonly #queued: string[] = [];
	#activeId: string | null = null;
	#counter = 0;

	get size(): number {
		return this.#pending.size;
	}

	get queuedCount(): number {
		return this.#queued.filter((id) => this.#pending.has(id)).length;
	}

	get active(): QueuedPiPrompt | undefined {
		return this.#activeId === null ? undefined : this.#pending.get(this.#activeId);
	}

	enqueue(
		envelope: RequestEnvelope,
		response: PromptResponse,
		createdAt = Date.now(),
	): QueuedPiPrompt {
		const id = String(++this.#counter);
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const completion = new Promise<void>((ok, fail) => {
			resolve = ok;
			reject = fail;
		});
		const request: MutableQueuedPiPrompt = {
			id,
			prompt: envelope.prompt,
			attachments: envelope.attachments ?? [],
			response,
			createdAt,
			completion,
			settled: false,
			resolve,
			reject,
		};
		this.#pending.set(id, request);
		this.#queued.push(id);
		return request;
	}

	/** Claim the next queued request. Only one PI turn may be active. */
	takeNext(): QueuedPiPrompt | undefined {
		if (this.#activeId !== null) return undefined;
		while (this.#queued.length > 0) {
			const id = this.#queued.shift()!;
			const request = this.#pending.get(id);
			if (!request) continue;
			this.#activeId = id;
			return request;
		}
		return undefined;
	}

	/** Put an injection that PI temporarily refused back at the queue head. */
	requeueActive(): void {
		if (this.#activeId === null) return;
		const id = this.#activeId;
		this.#activeId = null;
		if (this.#pending.has(id)) this.#queued.unshift(id);
	}

	completeActive(): QueuedPiPrompt | undefined {
		if (this.#activeId === null) return undefined;
		const request = this.#pending.get(this.#activeId);
		this.#pending.delete(this.#activeId);
		this.#activeId = null;
		if (request) this.#resolve(request);
		return request;
	}

	failActive(error: Error): QueuedPiPrompt | undefined {
		if (this.#activeId === null) return undefined;
		const request = this.#pending.get(this.#activeId);
		this.#pending.delete(this.#activeId);
		this.#activeId = null;
		if (request) this.#reject(request, error);
		return request;
	}

	/** Reject queued (never active) requests older than the cutoff. */
	expireQueued(cutoff: number): number {
		let expired = 0;
		for (const [id, request] of this.#pending) {
			if (id === this.#activeId || request.createdAt >= cutoff) continue;
			this.#pending.delete(id);
			this.#reject(request, new Error("PI prompt expired while waiting in the local queue"));
			expired++;
		}
		return expired;
	}

	/** Settle every active/queued handler before its AgentService is stopped. */
	failAll(reason: string): number {
		const requests = [...this.#pending.values()];
		this.#pending.clear();
		this.#queued.length = 0;
		this.#activeId = null;
		for (const request of requests) this.#reject(request, new Error(reason));
		return requests.length;
	}

	#resolve(request: MutableQueuedPiPrompt): void {
		if (request.settled) return;
		request.settled = true;
		request.resolve();
	}

	#reject(request: MutableQueuedPiPrompt, error: Error): void {
		if (request.settled) return;
		request.settled = true;
		request.reject(error);
	}
}
