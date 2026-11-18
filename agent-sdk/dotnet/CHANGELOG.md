# Changelog — Synadia.AI.Agents.Service / Synadia.AI.Agents.Testing (.NET host SDK)

All notable changes to these packages are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Initial .NET host SDK for wire protocol v0.3 (`0.1.0-preview.1`, targeting net8.0 and net10.0).
  - **`AgentService`.**
    - Registration: the `agents` micro service with spec metadata, and a prompt endpoint (queue group `agents`)
      advertising `max_payload`, `attachments_ok` and `min_sender_trust`.
    - Endpoints and liveness: a status endpoint, heartbeats, and keep-alive acks.
    - Errors: error frames via `RequestRejectedException`.
    - Shutdown: a graceful drain.
  - **`PromptStream`** streams `response` and `status` chunks, asks mid-stream queries with `AskAsync`, and writes the
    terminator for you. `AskApprovalAsync(ToolApprovalRequestContent, ToolApprovalOptions?, CancellationToken)` asks
    the caller to approve a tool call as a query and returns a `ToolApprovalResponseContent`; a timeout denies.
  - **Microsoft.Extensions.AI seams.**
    - `PromptContext.ToChatMessage()` and `PromptContext.SessionId` (the caller's `session_id` extra).
    - `PromptStream.WriteAsync(ChatResponseUpdate)`, which maps `AgentStatusContent` and
      `AdditionalProperties["synadia.status"]` to status.
    - `AgentService.ServeChatClient(IChatClient)`, a .NET-only convenience over `OnPrompt` that adds no wire feature.
      It hosts any chat client: tool approvals round-trip as §7 queries, an `AgentQueryContent` streamed by the
      inner client is relayed to the caller (so `ServeChatClient(remote.AsIChatClient())` works as a proxy), and the
      optional `AgentTools` lets the model delegate to other agents. `ChatClientServeOptions` has `ConversationKey`,
      `IncludeReasoning`, `QueryTimeout`, `MaxInputRounds`, `Approval`, `KeepHistory`, `MaxHistoryMessages` and
      `MaxConversations`.
  - **Conversations in `ServeChatClient`.** The conversation key defaults to the caller's `session_id` extra. When
    the inner client returns a `ConversationId`, only the newest id is kept per conversation and later calls
    (including tool-approval rounds) send just the new messages with `ChatOptions.ConversationId` set. Stateless
    clients keep a bounded in-memory history. `MaxConversations` (default 1000) bounds the conversations kept in
    memory: callers choose the key, so beyond the cap the least recently used idle conversation is evicted; one with
    a prompt in flight never is.
  - **Sender identity (§13).** Inbound `Agent-Sender` is verified and classified into `PromptContext.Sender`, and
    `min_sender_trust` is enforced (400/401/403/500 error frames), with `ReplayWindow`, an `AcceptSender` hook,
    `OperatorAttested` and `AccountTokenPosition`. `AgentServiceOptions.Identity` signs the agent's `id_sig` metadata.
  - Empty prompts and malformed envelopes are answered with a 400 error frame before the handler runs.
  - **`Synadia.AI.Agents.Testing`.**
    - `ReferenceAgent`, which supports `ask`, `fail`, `slow` and echo-with-history.
    - `NatsServerProcess`, a `nats-server` on a random free port.
  - **Packaging.** A consumer `PACKAGE.md` README per package, SourceLink, `.snupkg` symbols and deterministic CI
    builds. Public API baselines are enforced by PublicApiAnalyzers; RS0016/RS0017 fail the build.
  - Solution file `Synadia.AI.Agents.Service.slnx` (needs .NET SDK 9.0.200 or later; the repo pins 10.0.100).
  - **Tests.** End-to-end tests and TS interop in both directions (.NET caller ↔ TS reference agent, TS caller ↔ .NET
    reference agent, including queries and attachments).
  - **Examples.** `run-reference-agent.cs`, plus a host-side ladder mirroring the Python/TS agent-sdk examples
    (`examples/README.md`): `01-echo`, `02-ollama` (OllamaSharp), `03-openrouter` (`Microsoft.Extensions.AI.OpenAI`,
    `OPENAI_BASE_URL` override), `04-combined` (`llm`; with an OpenRouter key it serves MEAI's experimental
    `OrderedFailoverChatClient` (OpenRouter → Ollama, each route logged to stderr by `LoggingChatClient`), the one
    intentional deviation from Python/TS), `05-tools` (`read_sensor` `AIFunction` backed by a `sensors` NATS
    microservice) and `06-approvals` (agent `approvals`, session `main`: an approval-gated tool round-trips as a
    query). The shared `_shared/ExampleHost.cs` provides `--url`, `--owner`/`--session-name` with the
    `SYNADIA_<AGENT>_OWNER` ladder, `--heartbeat-interval`, `--nkey`/`--creds` and `--sender-identity signed`.

### Security

- Session ids are not access control: anyone who knows an id can continue that conversation. Combine the id with the
  sender identity in `ConversationKey` to bind conversations to a verified caller.