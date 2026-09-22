// `AgentTools` — the agent tools of `docs/agent-tools.md` as one helper: the
// definitions a model is shown, and the execution of a tool call by name.
//
//   discover_agents   the agents that can be prompted, one entry per address
//   prompt_agent      a prompt to one of them: waits for the reply or a
//                     question, or (`wait: false`) returns at once
//   wait_agent        the first of some calls that finished or asked
//   answer_agent      the answer to a call's open question
//   cancel_agent      stop calls: refuse their questions, drop their streams
//   list_agent_calls  the calls tracked in the current scope
//
// Everything is built on the caller API — `Agents.discover()`,
// `Agent.prompt()`, `QueryEvent.reply()`, `saveAttachments()` — so nothing
// changes on the wire: the agent being prompted sees an ordinary prompt.
//
// A host may offer a subset of the six (`tools`). Without `wait_agent`
// nothing can be detached, and a result points the model only to tools it
// has.
//
// A call is one prompt. Every call, blocking or not, is read by a task of
// its own from the moment it is sent: it collects the text, saves returned
// files, and queues questions, so its acks keep the stream alive while
// nobody waits and the reply is complete when the model asks for it. A
// blocking tool call only waits for that task to reach a state other than
// `running`.
//
// Calls live in a scope. A served prompt is one: `requestInterceptor` (for
// an `AgentService` host) or `runInPromptScope()` (for any other) runs the
// prompt's handler inside an `AsyncLocalStorage` that the tool calls made
// from it see, and cancels the calls still open when the handler is done.
// Outside any served prompt, tool calls share one scope that lives as long
// as the helper, and `onSettled` reports each call that finishes there.
//
// Errors the model can act on come back as results in words; the helper
// throws only for bugs (a misconfiguration, an extension that breaks the
// contract, use after `close()`).
//
// An application that imports this package without the tools should not
// carry them, and a bundler keeps a class it cannot prove inert even when
// nothing uses it. So members are TypeScript-private rather than
// `#`-private, and a field whose initial value takes a call is set in the
// constructor.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Agent } from "../agent.js";
import type { Agents } from "../agents.js";
import { ServiceError, StreamMaxWaitExceededError, StreamStalledError } from "../errors.js";
import type { SenderInfo } from "../identity/sender-header.js";
import { type Logger, SILENT_LOGGER } from "../internal/logger.js";
import { DEFAULT_PROMPT_MAX_WAIT_MS, type PromptOptions } from "../prompt/options.js";
import {
  DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES,
  saveAttachments,
} from "../prompt/save-attachments.js";
import type { QueryEvent } from "../query/query-event.js";
import type { PromptStream, ResponseAttachment } from "../stream/prompt-stream.js";
import {
  ArgsError,
  isArgsError,
  parseAnswerArgs,
  parseCancelArgs,
  parseDiscoverArgs,
  parsePromptArgs,
  parseWaitArgs,
} from "./args.js";
import {
  AGENT_TOOL_NAMES,
  offeredToolDefinitions,
  type AgentToolDefinition,
  type AgentToolName,
} from "./definitions.js";

/** Default for {@link AgentToolsOptions.maxCalls}: calls tracked per scope. */
export const DEFAULT_AGENT_TOOLS_MAX_CALLS = 256;

/**
 * What an open question is answered with when its call is cancelled — by
 * `cancel_agent`, a host's abort, or the end of the served prompt — and when
 * it fails or expires. It starts with `no`, so an agent that asked for a
 * permission reads a denial.
 */
export const AGENT_TOOLS_QUESTION_REFUSAL =
  "no: the caller stopped waiting for this prompt and cannot answer";

/** A call's state (docs/agent-tools.md, section 1.1). */
export type AgentCallState =
  "running" | "input_required" | "completed" | "failed" | "cancelled" | "expired";

/** A file the prompted agent sent, as a result lists it. */
export interface ReturnedFile {
  /** The name as the sender gave it. */
  readonly filename: string;
  /** The decoded size; `0` when the content was not valid base64. */
  readonly size_bytes: number;
  /** The absolute path of the saved file; `null` when it was not saved. */
  readonly path: string | null;
  /** Why the file was not saved; present iff `path` is `null`. */
  readonly skipped?: "over_limit" | "invalid_content";
}

/**
 * A tool's result: a JSON object the host hands its model as JSON text. The
 * shapes are in `test-fixtures/agent-tools/*.result.json`.
 */
export type AgentToolResult = Readonly<Record<string, unknown>>;

/** One call's result, as `prompt_agent`, `answer_agent`, `wait_agent` and `onSettled` give it. */
export interface AgentCallResult {
  readonly call_id: string;
  readonly state: AgentCallState;
  readonly label?: string;
  readonly reply?: string;
  readonly question?: string;
  readonly error?: string;
  readonly partial_reply?: string;
  readonly attachments?: ReadonlyArray<ReturnedFile>;
  /** Fields an extension added. */
  readonly [field: string]: unknown;
}

/** Per tool call: what the host knows about the model's call. */
export interface AgentToolCallOptions {
  /**
   * The model's ID for this tool call. `prompt_agent` puts it into the
   * prompt's `PromptOptions.context` as `toolCallId`, where every prompt
   * interceptor of the client finds it in `ctx.context`. Never sent.
   */
  readonly toolCallId?: string;
  /**
   * The host's abort for this tool call. It cancels a call a blocking
   * `prompt_agent` or `answer_agent` waits for, and ends a `wait_agent`
   * wait without touching the calls.
   */
  readonly signal?: AbortSignal;
}

/** What {@link AgentToolsOptions.onSettled} is told besides the result. */
export interface SettledInfo {
  /**
   * `true` when a tool call was waiting for this call as it finished, so its
   * result went to the model already.
   */
  readonly awaited: boolean;
}

/** What a prompt rewrite sees (docs/agent-tools.md, section 6.3). */
export interface AgentToolsPromptContext {
  readonly address: string;
  /** The prompt text, as the extensions before this one left it. */
  readonly prompt: string;
  /** The attachments' paths, resolved and checked against the roots. */
  readonly attachments: ReadonlyArray<string>;
  /** The agent the prompt goes to. */
  readonly target: Agent;
  /** The call's ID, as the model will see it. */
  readonly callId: string;
  readonly label: string | undefined;
  readonly toolCallId: string | undefined;
  /** The served prompt's verified sender, when there is one. */
  readonly caller: string | undefined;
}

/** What a prompt rewrite may return; every field optional. */
export interface AgentToolsPromptRewrite {
  /** The prompt's new text. */
  readonly prompt?: string;
  /** Values added to the prompt's `PromptOptions.context`. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Fields added to every result of the call. */
  readonly fields?: Readonly<Record<string, unknown>>;
  /** Refuse the prompt: nothing is sent, and the model gets this error. */
  readonly error?: string;
}

/** What a reply look sees (docs/agent-tools.md, section 6.3). */
export interface AgentToolsReplyContext {
  readonly callId: string;
  readonly address: string;
  readonly target: Agent;
  /** A completed reply, or a question as it arrives. */
  readonly kind: "reply" | "question";
  /** The whole reply, or the question. */
  readonly text: string;
  /** The files that came with it, saved. */
  readonly attachments: ReadonlyArray<ReturnedFile>;
}

type Fields = Readonly<Record<string, unknown>>;
type MaybePromise<T> = T | Promise<T>;

/**
 * An extension: any of three hooks, run in the order the extensions are
 * given. A hook may not set a field the contract defines; one that does is
 * a bug. The discovery and prompt hooks throw it; a reply look fails the
 * call and logs an error.
 */
export interface AgentToolsExtension {
  /** Extra fields for a `discover_agents` entry. */
  discoveryFields?(agent: Agent): MaybePromise<Fields | void>;
  /** A rewrite of the prompt before it is sent. */
  beforePrompt?(ctx: AgentToolsPromptContext): MaybePromise<AgentToolsPromptRewrite | void>;
  /**
   * A look at a completed reply or an arriving question, which may add
   * fields to that result. A throw fails the call.
   */
  afterReply?(ctx: AgentToolsReplyContext): MaybePromise<Fields | void>;
}

/**
 * The helper's request interceptor. Structurally a `RequestInterceptor` of
 * `@synadia-ai/agent-service`, which depends on this package and not the
 * other way round: pass it in `new AgentService({ interceptors: [...] })`.
 */
export interface AgentToolsRequestInterceptor {
  aroundRequest(
    ctx: { readonly sender?: SenderInfo | undefined },
    next: () => Promise<void>,
  ): Promise<void>;
}

/** Options of {@link AgentTools.runInPromptScope}. */
export interface PromptScopeOptions {
  /**
   * The served prompt's sender ID, `<account>.<user>`, when its signature
   * verified. `prompt_agent` refuses the agent that registered it. Leave it
   * unset for an unsigned or merely claimed sender.
   */
  readonly caller?: string;
}

export interface AgentToolsOptions {
  /** The caller-side client every discovery and prompt goes through. */
  readonly agents: Agents;
  /**
   * The tools offered, of the six; default all six. {@link AgentTools.definitions}
   * holds only these, in the contract's order, and `execute` refuses any
   * other. Without `wait_agent` nothing can be detached: `prompt_agent` and
   * `answer_agent` lose their `wait` parameter and refuse `wait: false`.
   * Every tool but `discover_agents` needs `prompt_agent`, which starts the
   * calls they work on, and `prompt_agent` needs `answer_agent`, or a
   * question the prompted agent asks could not be answered. Each definition
   * costs input tokens on every model call, so an agent that needs no async
   * calls offers `BLOCKING_AGENT_TOOLS`: `discover_agents`, `prompt_agent`
   * and `answer_agent`.
   */
  readonly tools?: ReadonlyArray<AgentToolName>;
  /** The agent's own address: left out of discovery, and refused. */
  readonly selfAddress?: string;
  /** How long one discovery waits; unset, the SDK's discovery default. */
  readonly discoverTimeoutMs?: number;
  /** The runtime limit per call; past it the call is `expired`. Default 10 minutes. */
  readonly maxWaitMs?: number;
  /** The cap on `wait_agent`'s `timeout_ms`, and its default. Default: `maxWaitMs`. */
  readonly maxWaitAgentMs?: number;
  /** Calls tracked per scope. Default {@link DEFAULT_AGENT_TOOLS_MAX_CALLS}. */
  readonly maxCalls?: number;
  /**
   * Directories files may be sent from besides the staging directory, which
   * always is one, the default or `stagingDir`: it holds the files other
   * agents sent back, so the model can send one on. A path is checked after
   * its links are followed, and a relative one is taken from the working
   * directory at construction. Default: none, so only returned files can be
   * sent. Name the working directory, say, to allow its files.
   */
  readonly attachmentRoots?: ReadonlyArray<string>;
  /**
   * Where returned files are saved, one directory per call; a relative path
   * is taken from the working directory at construction. Default: a new
   * private directory under the system's temporary directory, removed by
   * {@link AgentTools.close}. A directory given here is kept.
   */
  readonly stagingDir?: string;
  /** The total of returned files saved per call. Default 64 MiB. */
  readonly maxSavedBytesPerCall?: number;
  /**
   * Called for every call that finishes outside a served prompt, with its
   * result. A signal only: the tracked result is authoritative, and
   * `wait_agent` returns it. A throw is logged.
   */
  readonly onSettled?: (result: AgentCallResult, info: SettledInfo) => void | Promise<void>;
  /** Extensions, run in order. */
  readonly extensions?: ReadonlyArray<AgentToolsExtension>;
  /** For a failing `onSettled`, and an extension's bug in a reply look. Default: silent. */
  readonly logger?: Logger;
}

// The fields the contract defines. An extension may not set them.
const CALL_RESULT_FIELDS = [
  "call_id",
  "state",
  "label",
  "reply",
  "question",
  "error",
  "partial_reply",
  "attachments",
  "remaining",
  "call_ids",
  "open_calls",
  "open_calls_note",
];
const DISCOVERY_ENTRY_FIELDS = [
  "address",
  "agent",
  "owner",
  "name",
  "description",
  "identity",
  "identity_verified",
  "requires_signed_prompts",
  "accepts_attachments",
  "instances",
];

/** The helper. See the module comment and `docs/agent-tools.md`. */
export class AgentTools {
  /**
   * The definitions of the tools offered, the helper's own copy: a host
   * maps them to its tool format, and may change this copy without
   * touching another's.
   */
  readonly definitions: AgentToolDefinition[];
  /** Opens a scope per served prompt; see {@link AgentToolsRequestInterceptor}. */
  readonly requestInterceptor: AgentToolsRequestInterceptor;

  private readonly agents: Agents;
  private readonly offered: ReadonlySet<AgentToolName>;
  private readonly selfAddress: string | undefined;
  private readonly discoverTimeoutMs: number | undefined;
  private readonly maxWaitMs: number;
  private readonly maxWaitAgentMs: number;
  private readonly maxCalls: number;
  private readonly attachmentRoots: ReadonlyArray<string>;
  private readonly stagingOption: string | undefined;
  private readonly maxSavedBytes: number;
  private readonly onSettled: AgentToolsOptions["onSettled"];
  private readonly extensions: ReadonlyArray<AgentToolsExtension>;
  private readonly logger: Logger;
  private readonly cwd: string;
  private readonly scopeStore: AsyncLocalStorage<Scope>;
  private readonly root: Scope;
  private readonly served = new Set<Scope>();
  // Live handles by address, from the last discovery that saw them:
  // `prompt_agent` needs a handle, and the model only has the address.
  private readonly known = new Map<string, Agent>();
  private staging: Promise<string> | undefined;
  private ownsStaging = false;
  // Orders the events `wait_agent` picks from: a question, or a finish.
  private seq = 0;
  private closed = false;

  constructor(options: AgentToolsOptions) {
    this.agents = options.agents;
    this.offered = offeredTools(options.tools);
    this.selfAddress = options.selfAddress;
    this.discoverTimeoutMs = positive("discoverTimeoutMs", options.discoverTimeoutMs);
    this.maxWaitMs = positive("maxWaitMs", options.maxWaitMs) ?? DEFAULT_PROMPT_MAX_WAIT_MS;
    this.maxWaitAgentMs = nonNegative("maxWaitAgentMs", options.maxWaitAgentMs) ?? this.maxWaitMs;
    this.maxCalls = positive("maxCalls", options.maxCalls) ?? DEFAULT_AGENT_TOOLS_MAX_CALLS;
    if (!Number.isInteger(this.maxCalls)) {
      throw new RangeError(`AgentTools: maxCalls must be a whole number (got ${this.maxCalls})`);
    }
    this.cwd = process.cwd();
    // Relative roots are taken from the working directory now, as the
    // model's paths are: a later change of directory moves none of them.
    this.attachmentRoots = (options.attachmentRoots ?? []).map((root) => resolve(this.cwd, root));
    this.stagingOption =
      options.stagingDir !== undefined ? resolve(this.cwd, options.stagingDir) : undefined;
    this.maxSavedBytes =
      nonNegative("maxSavedBytesPerCall", options.maxSavedBytesPerCall) ??
      DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES;
    this.onSettled = options.onSettled;
    this.extensions = [...(options.extensions ?? [])];
    this.logger = options.logger ?? SILENT_LOGGER;
    this.scopeStore = new AsyncLocalStorage<Scope>();
    this.root = new Scope(false, undefined);
    this.definitions = offeredToolDefinitions(this.offered);
    this.requestInterceptor = {
      aroundRequest: (ctx, next) => {
        // A closed helper must not keep an agent from serving.
        if (this.closed) return next();
        const sender = ctx.sender;
        return this.runInPromptScope(
          next,
          sender?.trust === "verified" ? { caller: sender.id } : {},
        );
      },
    };
  }

  /**
   * Execute one tool call from the model and return its result, which the
   * host hands back as JSON text (`JSON.stringify(result)`). `args` is the
   * call's arguments as the model produced them: an object, or the JSON
   * text; none counts as `{}`. A tool the helper does not offer is refused
   * like any other mistake. Never throws for something the model got wrong.
   */
  async execute(
    name: string,
    args?: unknown,
    options: AgentToolCallOptions = {},
  ): Promise<AgentToolResult> {
    this.ensureOpen();
    const scope = this.scopeStore.getStore() ?? this.root;
    if (isAgentToolName(name) && !this.offered.has(name)) {
      return this.withOpenCalls(scope, {
        error: `the tool "${name}" is not offered; your tools are ${[...this.offered].join(", ")}`,
      });
    }
    let result: AgentToolResult;
    switch (name) {
      case "discover_agents":
        result = await this.discoverAgents(args);
        break;
      case "prompt_agent":
        result = await this.promptAgent(scope, args, options);
        break;
      case "wait_agent":
        result = await this.waitAgent(scope, args, options.signal);
        break;
      case "answer_agent":
        result = await this.answerAgent(scope, args, options.signal);
        break;
      case "cancel_agent":
        result = await this.cancelAgent(scope, args);
        break;
      case "list_agent_calls":
        result = this.listAgentCalls(scope);
        break;
      default:
        result = { error: `unknown tool "${name}"` };
    }
    return this.withOpenCalls(scope, result);
  }

  /**
   * Run `fn` as the handler of a served prompt: the tool calls it makes
   * share a scope of their own, and when `fn` settles, the calls still open
   * are cancelled and their questions refused. For hosts that serve prompts
   * without `AgentService`; on one, use {@link requestInterceptor}.
   */
  async runInPromptScope<T>(
    fn: () => T | Promise<T>,
    options: PromptScopeOptions = {},
  ): Promise<T> {
    this.ensureOpen();
    const scope = new Scope(true, options.caller);
    this.served.add(scope);
    try {
      return await this.scopeStore.run(scope, fn);
    } finally {
      this.served.delete(scope);
      await this.closeScope(scope);
    }
  }

  /**
   * Cancel every open call, in every scope, and remove the staging
   * directory when the helper created it. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([this.root, ...this.served].map((scope) => this.closeScope(scope)));
    if (this.ownsStaging && this.staging !== undefined) {
      const dir = await this.staging.catch(() => undefined);
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  }

  // --- discover_agents ----------------------------------------------------

  private async discoverAgents(args: unknown): Promise<AgentToolResult> {
    const parsed = parseDiscoverArgs(args);
    if (isArgsError(parsed)) return { error: parsed.error };
    let found: Agent[];
    try {
      found = await this.discover(parsed);
    } catch (err) {
      return { error: `discovery failed: ${describe(err)}` };
    }
    // Instances of one agent share its address and SHOULD register alike
    // (§3.4). When they do not, the entry shows one whose identity verifies.
    const byAddress = new Map<string, { handle: Agent; instances: number }>();
    for (const handle of found) {
      const address = handle.promptSubject;
      if (address === this.selfAddress) continue;
      const seen = byAddress.get(address);
      if (seen === undefined) byAddress.set(address, { handle, instances: 1 });
      else {
        seen.instances += 1;
        if (!seen.handle.idSigVerified && handle.idSigVerified) seen.handle = handle;
      }
    }
    const agents: Fields[] = [];
    for (const [address, { handle, instances }] of byAddress) {
      const extra: Record<string, unknown> = {};
      for (const extension of this.extensions) {
        if (extension.discoveryFields === undefined) continue;
        addFields(
          extra,
          await extension.discoveryFields(handle),
          DISCOVERY_ENTRY_FIELDS,
          "a discovery entry",
        );
      }
      agents.push({
        address,
        agent: handle.agent,
        owner: handle.owner,
        name: handle.name,
        description: handle.description,
        identity: handle.identity ?? null,
        identity_verified: handle.idSigVerified,
        requires_signed_prompts: handle.minSenderTrust === "signed",
        // As the SDK reads it: only an agent that says `false` refuses files.
        accepts_attachments: handle.promptEndpoint.attachmentsOk !== false,
        instances,
        ...extra,
      });
    }
    return { agents };
  }

  /** Discover, and remember the handle behind each address. */
  private async discover(filter: {
    agent?: string;
    owner?: string;
    name?: string;
  }): Promise<Agent[]> {
    const found = await this.agents.discover({
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
      ...(this.discoverTimeoutMs !== undefined ? { timeoutMs: this.discoverTimeoutMs } : {}),
    });
    for (const handle of found) {
      const known = this.known.get(handle.promptSubject);
      if (known === undefined || handle.idSigVerified || !known.idSigVerified) {
        this.known.set(handle.promptSubject, handle);
      }
    }
    return found;
  }

  /** The handle for an address: from an earlier discovery, else from a fresh one. */
  private async lookup(address: string): Promise<Agent | undefined> {
    const known = this.known.get(address);
    if (known !== undefined) return known;
    await this.discover({});
    return this.known.get(address);
  }

  // --- prompt_agent -------------------------------------------------------

  private async promptAgent(
    scope: Scope,
    args: unknown,
    options: AgentToolCallOptions,
  ): Promise<AgentToolResult> {
    const parsed = parsePromptArgs(args);
    if (isArgsError(parsed)) return { error: parsed.error };
    if (!parsed.wait && !this.offered.has("wait_agent")) {
      return {
        error:
          'prompt_agent: "wait" cannot be false here; the call waits for the reply or a question',
      };
    }
    const { address } = parsed;
    if (scope.closed) {
      return { error: "the prompt you were answering has ended; no call can start in it" };
    }
    if (address === this.selfAddress) {
      return { error: `"${address}" is your own address; answer the prompt yourself` };
    }
    let target: Agent | undefined;
    try {
      target = await this.lookup(address);
    } catch (err) {
      return { error: `could not look up "${address}": ${describe(err)}` };
    }
    if (target === undefined) return { error: this.noAgentAt(address) };
    if (scope.caller !== undefined && target.identity === scope.caller) {
      return {
        error:
          `the agent at "${address}" sent the prompt you are answering; ` +
          "answer it rather than prompting it back",
      };
    }
    const attachments = await this.resolveAttachments(parsed.attachments);
    if (isArgsError(attachments)) return { error: attachments.error };
    if (!this.reserve(scope)) {
      const { collect, stop } = this.openCallActions("some", "their");
      const actions = [collect, stop].filter((action) => action !== undefined);
      return {
        error:
          `all ${this.maxCalls} tracked calls are still open; ` +
          (actions.length > 0
            ? `${actions.join(" or ")} before you start another`
            : "another can start when one of them finishes"),
      };
    }

    let reserved = true;
    try {
      const callId = newCallId();
      let text = parsed.prompt;
      const context: Record<string, unknown> = {};
      const fields: Record<string, unknown> = {};
      for (const extension of this.extensions) {
        if (extension.beforePrompt === undefined) continue;
        const rewrite = await extension.beforePrompt({
          address,
          prompt: text,
          attachments,
          target,
          callId,
          label: parsed.label,
          toolCallId: options.toolCallId,
          caller: scope.caller,
        });
        if (!rewrite) continue;
        if (rewrite.error !== undefined) return { error: rewrite.error };
        if (rewrite.prompt !== undefined) text = rewrite.prompt;
        Object.assign(context, rewrite.context);
        addFields(fields, rewrite.fields, CALL_RESULT_FIELDS, "a call's result");
      }
      if (options.toolCallId !== undefined) context["toolCallId"] = options.toolCallId;
      const promptOptions: PromptOptions = {
        maxWaitMs: this.maxWaitMs,
        context,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      let stream: PromptStream;
      try {
        // `prompt()` checks before sending, and some checks throw synchronously.
        stream = await target.prompt(text, promptOptions);
      } catch (err) {
        return { error: `the prompt was not sent: ${describe(err)}` };
      }
      if (scope.closed) {
        // Nothing went out yet: a stream publishes on its first iteration.
        stream.cancel();
        return { error: "the prompt you were answering has ended; no call can start in it" };
      }
      const call = new Call(
        callId,
        scope,
        address,
        target,
        parsed.label,
        !parsed.wait,
        fields,
        stream,
      );
      scope.reserved -= 1;
      reserved = false;
      scope.calls.set(callId, call);
      void this.read(call);
      if (!parsed.wait) return this.callResult(call);
      return await this.untilReady(call, options.signal);
    } finally {
      if (reserved) scope.reserved -= 1;
    }
  }

  /**
   * Make room for one more call in `scope`: drop finished calls, the one
   * that finished longest ago first. `false` when every tracked call is open.
   */
  private reserve(scope: Scope): boolean {
    while (scope.calls.size + scope.reserved >= this.maxCalls) {
      let oldest: Call | undefined;
      for (const call of scope.calls.values()) {
        if (!call.open && (oldest === undefined || call.seq < oldest.seq)) oldest = call;
      }
      if (oldest === undefined) return false;
      scope.calls.delete(oldest.id);
    }
    scope.reserved += 1;
    return true;
  }

  /** Each path, links followed, if it is a file under an allowed root. */
  private async resolveAttachments(paths: ReadonlyArray<string>): Promise<string[] | ArgsError> {
    if (paths.length === 0) return [];
    const roots = await Promise.all(
      [await this.stagingDir(), ...this.attachmentRoots].map((root) =>
        realpath(root).catch(() => root),
      ),
    );
    const out: string[] = [];
    for (const path of paths) {
      let real: string;
      try {
        real = await realpath(resolve(this.cwd, path));
      } catch {
        return new ArgsError(`prompt_agent: the attachment "${path}" does not exist`);
      }
      const info = await stat(real).catch(() => undefined);
      if (!info?.isFile()) {
        return new ArgsError(`prompt_agent: the attachment "${path}" is not a file`);
      }
      if (!roots.some((root) => real === root || real.startsWith(withSep(root)))) {
        return new ArgsError(
          `prompt_agent: "${path}" is outside the directories you may send files from ` +
            `(${roots.join(", ")})`,
        );
      }
      out.push(real);
    }
    return out;
  }

  // --- the call's own task -------------------------------------------------

  /** Read a call's stream to its end; see the module comment. */
  private async read(call: Call): Promise<void> {
    try {
      for await (const msg of call.stream) {
        if (msg.type === "status") continue;
        if (!call.open) {
          // Cancelled while this message was on its way.
          if (msg.type === "query") await refuse(msg);
          continue;
        }
        if (msg.type === "response") {
          call.text += msg.text;
          if (msg.attachments !== undefined && msg.attachments.length > 0) {
            call.replyFiles.push(...(await this.save(call, msg.attachments)));
          }
          continue;
        }
        call.arriving = msg;
        const files =
          msg.attachments !== undefined && msg.attachments.length > 0
            ? await this.save(call, msg.attachments)
            : [];
        const fields = await this.afterReply(call, "question", msg.prompt, files);
        // Cancelled meanwhile: `cancel()` took the question and refused it.
        if (!call.open) continue;
        call.arriving = undefined;
        call.questions.push({ event: msg, files, fields });
        if (call.state === "running") this.setState(call, "input_required");
      }
      if (call.open) {
        call.replyFields = await this.afterReply(call, "reply", call.text, call.replyFiles);
        this.finish(call, "completed");
      }
    } catch (err) {
      // Cancelled already: `cancel()` refused every question, the one being taken in too.
      if (!call.open) return;
      const open =
        err instanceof StreamMaxWaitExceededError
          ? this.finish(
              call,
              "expired",
              `the call ran past its runtime limit of ${duration(err.maxWaitMs)} and was stopped; ` +
                "the agent may still be working on it",
            )
          : this.finish(call, "failed", this.failure(call, err));
      // Nobody can answer them now: the asking agent hears so at once
      // rather than waiting out its own timeout.
      await Promise.all(open.map(refuse));
    }
  }

  private async save(
    call: Call,
    attachments: ReadonlyArray<ResponseAttachment>,
  ): Promise<ReturnedFile[]> {
    let saved;
    try {
      const dir = join(await this.stagingDir(), call.id);
      saved = await saveAttachments(attachments, dir, {
        maxTotalBytes: Math.max(0, this.maxSavedBytes - call.savedBytes),
      });
    } catch (err) {
      throw new CallFailure(`a file the agent sent could not be saved: ${describe(err)}`);
    }
    return saved.map((file) => {
      if (file.path !== null) call.savedBytes += file.sizeBytes;
      return {
        filename: file.filename,
        size_bytes: file.sizeBytes,
        path: file.path,
        ...(file.skipped !== undefined ? { skipped: file.skipped } : {}),
      };
    });
  }

  private async afterReply(
    call: Call,
    kind: "reply" | "question",
    text: string,
    attachments: ReadonlyArray<ReturnedFile>,
  ): Promise<Fields> {
    const fields: Record<string, unknown> = {};
    try {
      for (const extension of this.extensions) {
        if (extension.afterReply === undefined) continue;
        const added = await extension.afterReply({
          callId: call.id,
          address: call.address,
          target: call.target,
          kind,
          text,
          attachments,
        });
        addFields(fields, added, CALL_RESULT_FIELDS, "a call's result");
      }
    } catch (err) {
      if (err instanceof ReservedFieldError) {
        // The discovery and prompt hooks throw this bug. The reply look runs
        // in the call's reader, outside any tool call, with nobody to throw
        // to: it fails the call, loudly.
        this.logger.error(
          `AgentTools: an extension bug: afterReply set "${err.field}", a field the contract defines; the call fails`,
          { call_id: call.id, kind, field: err.field },
        );
        throw new CallFailure(
          `an extension of these tools has a bug (it set "${err.field}" on the ${kind}, ` +
            `a field the tools define); the agent at "${call.address}" is not at fault`,
        );
      }
      throw new CallFailure(`an extension failed on the ${kind}: ${describe(err)}`);
    }
    return fields;
  }

  private failure(call: Call, err: unknown): string {
    if (err instanceof CallFailure) return err.message;
    if (err instanceof ServiceError) {
      const detail = err.description !== "" ? ` ${err.description}` : "";
      return `the agent at "${call.address}" answered with an error: ${err.code}${detail}`;
    }
    if (err instanceof StreamStalledError) {
      return (
        `the agent at "${call.address}" sent nothing for ${duration(err.timeoutMs)}, ` +
        "so the call was given up; the agent may have stopped"
      );
    }
    if (err instanceof Error && err.name === "NoRespondersError") {
      return this.noAgentAt(call.address, " any more");
    }
    if (err instanceof Error && err.name === "AbortError") {
      return "the client the call ran on was closed";
    }
    return describe(err);
  }

  // --- state ---------------------------------------------------------------

  private setState(call: Call, state: "running" | "input_required"): void {
    call.state = state;
    if (state === "input_required") call.seq = ++this.seq;
    call.notify();
  }

  /**
   * The call's final state; the first one wins. Returns the questions that
   * were open and the one being taken in, taken off the call: the caller
   * refuses them, except on `completed`, where the stream has ended and they
   * are moot.
   */
  private finish(
    call: Call,
    state: Exclude<AgentCallState, "running" | "input_required">,
    error?: string,
  ): QueryEvent[] {
    if (!call.open) return [];
    const awaited = call.awaited;
    call.state = state;
    call.error = error;
    call.endedAt = new Date();
    call.seq = ++this.seq;
    const open = call.questions.splice(0).map((q) => q.event);
    if (call.arriving !== undefined) open.push(call.arriving);
    call.arriving = undefined;
    call.notify();
    if (call.scope === this.root && this.onSettled !== undefined) {
      const report = this.onSettled;
      const result = this.callResult(call);
      void (async () => {
        try {
          await report(result, { awaited });
        } catch {
          this.logger.error("AgentTools onSettled failed", { call_id: call.id });
        }
      })();
    }
    return open;
  }

  /** Refuse the call's open questions, and the one being taken in; drop its stream. */
  private async cancel(call: Call): Promise<void> {
    if (!call.open) return;
    const questions = this.finish(call, "cancelled");
    call.stream.cancel();
    await Promise.all(questions.map(refuse));
  }

  private async closeScope(scope: Scope): Promise<void> {
    scope.closed = true;
    await Promise.all([...scope.calls.values()].map((call) => this.cancel(call)));
  }

  /** Wait until the call is no longer `running`; an abort cancels it. */
  private async untilReady(call: Call, signal: AbortSignal | undefined): Promise<AgentCallResult> {
    while (call.state === "running") {
      if (signal?.aborted) {
        await this.cancel(call);
        break;
      }
      await nextChange([call], undefined, signal);
    }
    return this.callResult(call);
  }

  // --- wait_agent, answer_agent, cancel_agent, list_agent_calls -----------

  private async waitAgent(
    scope: Scope,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult> {
    const parsed = parseWaitArgs(args);
    if (isArgsError(parsed)) return { error: parsed.error };
    const calls = this.calls(scope, parsed.callIds);
    if (isArgsError(calls)) return { error: calls.error };
    const deadline =
      Date.now() + Math.min(parsed.timeoutMs ?? this.maxWaitAgentMs, this.maxWaitAgentMs);
    for (;;) {
      let first: Call | undefined;
      for (const call of calls) {
        if (call.state !== "running" && (first === undefined || call.seq < first.seq)) {
          first = call;
        }
      }
      if (first !== undefined) {
        const ready = first;
        return {
          ...this.callResult(ready),
          remaining: calls.filter((call) => call !== ready && call.open).map((call) => call.id),
        };
      }
      if (Date.now() >= deadline || signal?.aborted) {
        return { state: "running", call_ids: calls.map((call) => call.id) };
      }
      await nextChange(calls, deadline, signal);
    }
  }

  private async answerAgent(
    scope: Scope,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult> {
    const parsed = parseAnswerArgs(args);
    if (isArgsError(parsed)) return { error: parsed.error };
    if (parsed.wait === false && !this.offered.has("wait_agent")) {
      return {
        error:
          'answer_agent: "wait" cannot be false here; the call waits for the reply or the next question',
      };
    }
    const call = scope.calls.get(parsed.callId);
    if (call === undefined) return { error: this.unknownCalls([parsed.callId]) };
    const question = call.questions[0];
    if (call.state !== "input_required" || question === undefined) {
      return {
        error:
          `call "${call.id}" has no open question: it is ${call.state}` +
          (call.open ? "" : this.ifOffered("wait_agent", "; wait_agent returns its result")),
      };
    }
    // Taken off before the answer goes out, so a concurrent tool call never
    // sees a question that is being answered.
    call.questions.shift();
    if (call.questions.length > 0) this.setState(call, "input_required");
    else this.setState(call, "running");
    try {
      await question.event.reply(parsed.answer);
    } catch (err) {
      if (call.open) {
        call.questions.unshift(question);
        this.setState(call, "input_required");
      }
      return { error: `the answer could not be sent: ${describe(err)}` };
    }
    if (!(parsed.wait ?? !call.detached)) return this.callResult(call);
    return this.untilReady(call, signal);
  }

  private async cancelAgent(scope: Scope, args: unknown): Promise<AgentToolResult> {
    const parsed = parseCancelArgs(args);
    if (isArgsError(parsed)) return { error: parsed.error };
    const calls: Fields[] = [];
    for (const id of parsed.callIds) {
      const call = scope.calls.get(id);
      if (call === undefined) {
        calls.push({ call_id: id, error: this.unknownCalls([id]) });
        continue;
      }
      await this.cancel(call);
      calls.push(this.callResult(call));
    }
    return { calls };
  }

  private listAgentCalls(scope: Scope): AgentToolResult {
    return {
      calls: [...scope.calls.values()].map((call) => ({
        call_id: call.id,
        ...(call.label !== undefined ? { label: call.label } : {}),
        address: call.address,
        state: call.state,
        started_at: call.startedAt.toISOString(),
        ...(call.endedAt !== undefined ? { ended_at: call.endedAt.toISOString() } : {}),
      })),
    };
  }

  /** The calls `ids` name in `scope`, or an error naming the ones it does not track. */
  private calls(scope: Scope, ids: ReadonlyArray<string>): Call[] | ArgsError {
    const unknown = ids.filter((id) => !scope.calls.has(id));
    if (unknown.length > 0) return new ArgsError(this.unknownCalls(unknown));
    return ids.map((id) => scope.calls.get(id)!);
  }

  // --- words -------------------------------------------------------------------
  //
  // What a result tells the model to do next points only to tools the
  // helper offers: the model can call no other.

  private ifOffered(tool: AgentToolName, words: string): string {
    return this.offered.has(tool) ? words : "";
  }

  private unknownCalls(ids: ReadonlyArray<string>): string {
    return (
      `${ids.map((id) => `"${id}"`).join(", ")}: no such call in your calls` +
      this.ifOffered("list_agent_calls", "; list_agent_calls shows them")
    );
  }

  private noAgentAt(address: string, still = ""): string {
    return (
      `no agent answers at "${address}"${still}` +
      this.ifOffered("discover_agents", "; call discover_agents for the current list")
    );
  }

  /**
   * What the model can do about open calls with the tools it has: collect
   * them, or answer their questions when nothing is detached, and stop them.
   */
  private openCallActions(
    them: string,
    their: string,
  ): { collect: string | undefined; stop: string | undefined } {
    return {
      collect: this.offered.has("wait_agent")
        ? `collect ${them} with wait_agent`
        : this.offered.has("answer_agent")
          ? `answer ${their} questions with answer_agent`
          : undefined,
      stop: this.offered.has("cancel_agent") ? `stop ${them} with cancel_agent` : undefined,
    };
  }

  // --- results -------------------------------------------------------------

  private callResult(call: Call): AgentCallResult {
    const base = {
      ...call.fields,
      call_id: call.id,
      state: call.state,
      ...(call.label !== undefined ? { label: call.label } : {}),
    };
    const partial = call.text !== "" ? { partial_reply: call.text } : {};
    const files = call.replyFiles.length > 0 ? { attachments: [...call.replyFiles] } : {};
    switch (call.state) {
      case "running":
        return base;
      case "input_required": {
        const question = call.questions[0]!;
        return {
          ...base,
          ...question.fields,
          question: question.event.prompt,
          ...(question.files.length > 0 ? { attachments: [...question.files] } : {}),
        };
      }
      case "completed":
        return { ...base, ...call.replyFields, reply: call.text, ...files };
      case "cancelled":
        return { ...base, ...partial, ...files };
      case "failed":
      case "expired":
        return { ...base, error: call.error ?? "the call failed", ...partial, ...files };
    }
  }

  /** Say how many calls are open, when any is. */
  private withOpenCalls(scope: Scope, result: AgentToolResult): AgentToolResult {
    let open = 0;
    for (const call of scope.calls.values()) if (call.open) open += 1;
    if (open === 0) return result;
    const counted = open === 1 ? "1 call you started is" : `${open} calls you started are`;
    const { collect, stop } = this.openCallActions(
      open === 1 ? "it" : "them",
      open === 1 ? "its" : "their",
    );
    let note: string;
    if (scope.served) {
      note =
        `${counted} still open. Calls end with the prompt you are answering` +
        (collect !== undefined ? `: ${collect} before you answer.` : ".");
    } else {
      const actions = [collect, stop].filter((action) => action !== undefined);
      note = `${counted} still open` + (actions.length > 0 ? `: ${actions.join(", or ")}.` : ".");
    }
    return { ...result, open_calls: open, open_calls_note: note };
  }

  // --- files -------------------------------------------------------------------

  private stagingDir(): Promise<string> {
    this.staging ??= (async (): Promise<string> => {
      if (this.stagingOption !== undefined) {
        const dir = this.stagingOption;
        await mkdir(dir, { recursive: true, mode: 0o700 });
        return dir;
      }
      const dir = await mkdtemp(join(tmpdir(), "agent-tools-"));
      this.ownsStaging = true;
      return dir;
    })().catch((err: unknown) => {
      this.staging = undefined;
      throw err;
    });
    return this.staging;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("AgentTools: the helper is closed");
  }
}

/** One question a call's stream asked, while it is open. */
interface OpenQuestion {
  readonly event: QueryEvent;
  readonly files: ReadonlyArray<ReturnedFile>;
  readonly fields: Fields;
}

/** Where calls live: one per served prompt, and one for everything else. */
class Scope {
  /** In the order started. */
  readonly calls = new Map<string, Call>();
  /** Calls admitted but not yet started. */
  reserved = 0;
  closed = false;

  constructor(
    readonly served: boolean,
    readonly caller: string | undefined,
  ) {}
}

/** One prompt and what came back so far. */
class Call {
  state: AgentCallState = "running";
  /** When it last became ready (a question, or its finish), for `wait_agent`'s order. */
  seq = 0;
  readonly startedAt: Date;
  endedAt: Date | undefined;
  text = "";
  readonly replyFiles: ReturnedFile[] = [];
  /** Oldest first; the first is the one the call's result shows. */
  readonly questions: OpenQuestion[] = [];
  /**
   * A question whose files are being saved and whose reply look runs: not
   * yet in `questions`, and either step may fail the call.
   */
  arriving: QueryEvent | undefined;
  error: string | undefined;
  replyFields: Fields = {};
  savedBytes = 0;
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly scope: Scope,
    readonly address: string,
    readonly target: Agent,
    readonly label: string | undefined,
    /** Started with `wait: false`. */
    readonly detached: boolean,
    /** Fields a prompt rewrite added. */
    readonly fields: Fields,
    readonly stream: PromptStream,
  ) {
    this.startedAt = new Date();
  }

  get open(): boolean {
    return this.state === "running" || this.state === "input_required";
  }

  /** Whether a tool call waits for this call right now. */
  get awaited(): boolean {
    return this.waiters.size > 0;
  }

  watch(waiter: () => void): void {
    this.waiters.add(waiter);
  }

  unwatch(waiter: () => void): void {
    this.waiters.delete(waiter);
  }

  /** Wake every tool call waiting for this call. */
  notify(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
  }
}

/** A call's failure, in words, raised inside its task. */
class CallFailure extends Error {}

/** An extension set a field the contract defines: a bug in the extension. */
class ReservedFieldError extends Error {
  constructor(
    readonly field: string,
    where: string,
  ) {
    super(`AgentTools: an extension may not set "${field}" on ${where}`);
  }
}

/** Resolves on the next change of any of `calls`, at `deadline`, or on abort. */
function nextChange(
  calls: ReadonlyArray<Call>,
  deadline: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolveChange) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      for (const call of calls) call.unwatch(done);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveChange();
    };
    for (const call of calls) call.watch(done);
    if (deadline !== undefined) timer = setTimeout(done, Math.max(0, deadline - Date.now()));
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

async function refuse(question: QueryEvent): Promise<void> {
  try {
    await question.reply(AGENT_TOOLS_QUESTION_REFUSAL);
  } catch {
    // Already answered, or the connection is gone: nothing more to say.
  }
}

/** Merge an extension's fields, refusing the ones the contract defines. */
function addFields(
  into: Record<string, unknown>,
  added: Fields | void | undefined,
  reserved: ReadonlyArray<string>,
  where: string,
): void {
  if (added === undefined || added === null) return;
  for (const [key, value] of Object.entries(added)) {
    if (reserved.includes(key)) {
      throw new ReservedFieldError(key, where);
    }
    into[key] = value;
  }
}

function newCallId(): string {
  return `call_${randomBytes(6).toString("hex")}`;
}

function isAgentToolName(name: string): name is AgentToolName {
  return (AGENT_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}

/**
 * The tools offered, in the contract's order. A set that makes no sense is
 * a misconfiguration and throws: a name not of the six, no tool at all, a
 * tool that works on calls without `prompt_agent`, which starts them, or
 * `prompt_agent` without `answer_agent`, which answers their questions.
 */
function offeredTools(tools: ReadonlyArray<string> | undefined): ReadonlySet<AgentToolName> {
  if (tools === undefined) return new Set(AGENT_TOOL_NAMES);
  for (const name of tools) {
    if (!isAgentToolName(name)) {
      throw new RangeError(
        `AgentTools: tools names "${name}", which is not one of ${AGENT_TOOL_NAMES.join(", ")}`,
      );
    }
  }
  const offered = new Set(AGENT_TOOL_NAMES.filter((name) => tools.includes(name)));
  if (offered.size === 0) {
    throw new RangeError(
      "AgentTools: tools names no tool; a role that must not delegate needs no AgentTools",
    );
  }
  const orphans = [...offered].filter((name) => name !== "discover_agents");
  if (!offered.has("prompt_agent") && orphans.length > 0) {
    throw new RangeError(
      `AgentTools: tools offers ${orphans.join(", ")} without prompt_agent, which starts the calls ` +
        (orphans.length === 1 ? "it works on" : "they work on"),
    );
  }
  if (offered.has("prompt_agent") && !offered.has("answer_agent")) {
    throw new RangeError(
      "AgentTools: tools offers prompt_agent without answer_agent, so a question the prompted " +
        "agent asks would reach a model with no way to answer it, and the asking agent would " +
        "wait out its timeout",
    );
  }
  return offered;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function duration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (ms >= 1_000 && ms % 1_000 === 0) {
    const seconds = ms / 1_000;
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  return `${ms} ms`;
}

function withSep(dir: string): string {
  return dir.endsWith(sep) ? dir : dir + sep;
}

function positive(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!(value > 0))
    throw new RangeError(`AgentTools: ${name} must be greater than 0 (got ${value})`);
  return value;
}

function nonNegative(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!(value >= 0)) throw new RangeError(`AgentTools: ${name} must be 0 or more (got ${value})`);
  return value;
}
