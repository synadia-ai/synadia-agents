/**
 * The runs PI starts that no NATS prompt started: typed at PI's terminal,
 * or begun by PI itself. Each is a local turn for the extensions, from the
 * run's `agent_start` to its `agent_settled`, as a NATS prompt is a served
 * request from its hand-over to its settle.
 *
 * The rules, which the channel applies at PI's events:
 *
 *   - **open** at `agent_start` when no NATS prompt is active and no local
 *     turn is open. A run PI continues (`agent.continue()`) fires
 *     `agent_start` again inside the same run, so "none open" keeps one run
 *     one turn. A NATS prompt's run sees its prompt active, since the queue
 *     marks it active before the hand-over, and opens none;
 *   - **close** at `agent_settled`, before the channel completes the active
 *     request and hands PI the next queued prompt, so a NATS prompt never
 *     starts inside a local turn; or at the session's end;
 *   - the turn the model works in is the active NATS prompt, else the open
 *     local turn: what the provider-headers and tool hooks are given.
 *
 * An id is `local-<n>`; a request id is a number, so the two never meet.
 *
 * Stated honestly: text typed while a run is going joins that run, whether
 * a NATS prompt or a local turn started it. PI gives the channel no way to
 * tell the two apart.
 */

import type { LocalTurn, ServedRequest } from "./extensions.ts";

/** The prefix of every local turn's id; request ids are numbers. */
export const LOCAL_TURN_PREFIX = "local-";

export class PiLocalTurns {
	readonly #active: () => ServedRequest | undefined;
	#open: LocalTurn | undefined;
	#counter = 0;

	/** `active`: the NATS prompt PI is working on now, if any. */
	constructor(active: () => ServedRequest | undefined) {
		this.#active = active;
	}

	/** The open local turn, if any. */
	get open(): LocalTurn | undefined {
		return this.#open;
	}

	/**
	 * At `agent_start`: open a local turn when no NATS prompt is active and
	 * none is open. Returns the turn it opened, else `undefined`.
	 */
	start(): LocalTurn | undefined {
		if (this.#open !== undefined || this.#active() !== undefined) return undefined;
		const turn: LocalTurn = Object.freeze({
			id: `${LOCAL_TURN_PREFIX}${++this.#counter}`,
			local: true as const,
		});
		this.#open = turn;
		return turn;
	}

	/** At `agent_settled` or the session's end: close the open local turn and return it. */
	end(): LocalTurn | undefined {
		const turn = this.#open;
		this.#open = undefined;
		return turn;
	}

	/** The turn the model works in: the active NATS prompt, else the open local turn. */
	current(): ServedRequest | LocalTurn | undefined {
		return this.#active() ?? this.#open;
	}
}
