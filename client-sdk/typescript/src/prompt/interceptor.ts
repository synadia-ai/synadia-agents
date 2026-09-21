// Prompt interceptors — the caller-side hook around `Agent.prompt()`, in
// two phases. Both run once per prompt, in the order the client lists the
// interceptors, and see the same per-prompt context: the target agent, the
// prompt text, the opaque `context` the caller passed in `PromptOptions`,
// the connection, and signing with the prompting client's identity.
//
// 1. `beforePrompt(ctx)` decides what the prompt carries: it returns extra
//    envelope fields and extra headers, or nothing, and has no side
//    effects — the prompt may still fail after it (its identity at publish
//    time, the size of the envelope its fields make).
// 2. `beforePublish(ctx, extras)`, optional, runs only once the prompt is
//    certain to go out: after its `Agent-Sender` header is signed and its
//    size checked, immediately before it is published. This is where an
//    interceptor publishes messages of its own, so a message about a
//    prompt describes one that went out, barring a transport failure. It
//    receives what its own `beforePrompt` returned — `state` included —
//    so an interceptor keeps nothing between the phases itself.
//
// The SDK gives the fields and headers no meaning. §5.6 obliges a receiver
// to tolerate unknown top-level envelope fields; a host built on
// `@synadia-ai/agent-service` reads them back from `RequestEnvelope.extras`
// and the request's headers in its own request interceptors.
//
// When they run: at publish time, on the stream's first iteration, so a
// prompt that is never iterated, or that `prompt()` itself rejects, runs
// neither phase. Both run in the async context `prompt()` was called in,
// not the one the stream happens to be iterated in, so an interceptor that
// reads an AsyncLocalStorage sees the caller's value.

import type { NatsConnection } from "@nats-io/nats-core";
import type { Agent } from "../agent.js";
import type { AgentId } from "../identity/agent-id.js";
import type { SignedPublishOptions } from "../identity/signed-publish.js";

/**
 * Signing with the prompting client's identity — the one that signs the
 * prompt's own `Agent-Sender` header. The same rules as the `Agents`
 * methods of the same names.
 */
export interface PromptSigning {
  /** `true` iff a signer is configured, so {@link publishSigned} can sign. */
  readonly canSign: boolean;
  /** The client's own agent ID (`{account}.{user}`), as `Agents.selfId()`. */
  selfId(): Promise<AgentId>;
  /**
   * Sign and publish one message, as `Agents.publishSigned()`: its
   * `Agent-Sender` header, and `Nats-Msg-Id` set to the nonce. Pass
   * `opts.nonce` for a body that carries its own id.
   */
  publishSigned(
    subject: string,
    payload: Uint8Array | string,
    opts?: SignedPublishOptions,
  ): Promise<void>;
}

/** What a {@link PromptInterceptor} sees. */
export interface PromptInterceptorContext {
  /** The agent the prompt is addressed to. */
  readonly agent: Agent;
  /** The prompt text. */
  readonly prompt: string;
  /** `PromptOptions.context`, verbatim; `{}` when the caller passed none. */
  readonly context: Readonly<Record<string, unknown>>;
  /** The connection the prompt goes out on. */
  readonly connection: NatsConnection;
  /** Signing with the prompting client's identity. */
  readonly identity: PromptSigning;
}

/** What a {@link PromptInterceptor} adds to the prompt, from its first phase. */
export interface PromptExtras {
  /**
   * Extra top-level envelope fields, by wire name. `prompt` and
   * `attachments` belong to the protocol and are refused.
   */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Extra message headers. `Agent-Sender` belongs to the SDK and is refused. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Anything the interceptor wants back in its second phase. Opaque to the
   * SDK: never sent, handed to `beforePublish` as returned.
   */
  readonly state?: unknown;
}

/** A caller-side hook around each prompt, in two phases (see the module comment). */
export interface PromptInterceptor {
  /**
   * Phase one: what the prompt carries. No side effects — the prompt may
   * still fail after it. A throw fails the prompt: it surfaces from the
   * stream's first iteration, and nothing is sent.
   */
  beforePrompt(ctx: PromptInterceptorContext): PromptExtras | void | Promise<PromptExtras | void>;
  /**
   * Phase two, optional: runs after the prompt's header is signed and its
   * size checked, immediately before it is published — the place to
   * publish messages of the interceptor's own. `extras` is what this
   * interceptor's `beforePrompt` returned for the same `ctx`. A throw is
   * logged and does not stop the prompt, which by then is due to go out.
   */
  beforePublish?(
    ctx: PromptInterceptorContext,
    extras: PromptExtras | undefined,
  ): void | Promise<void>;
}
