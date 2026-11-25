# Protocol mapping — .NET SDK (`Synadia.AI.Agents` + `Synadia.AI.Agents.Service`)

This file maps the spec to the .NET implementation. The spec itself is
[`synadia-ai/synadia-agent-sdk-docs`](https://github.com/synadia-ai/synadia-agent-sdk-docs) and is the source of truth;
this file is not. Wire protocol: **v0.3** (`ProtocolVersion.Sdk`).

## Subjects and service registration

| Spec | .NET |
| --- | --- |
| Micro service `agents`, metadata `agent`, `owner`, `name`, `session?`, `protocol_version` | `AgentService.StartAsync` (NATS.Client.Services `AddServiceAsync`) |
| Prompt endpoint `agents.prompt.{agent}.{owner}.{name}[.{session}]`, queue group `agents`; metadata `max_payload`, `attachments_ok`, `min_sender_trust` | `AgentSubject`, `AgentProtocol.PromptQueueGroup`, `AgentServiceOptions.MaxPayload/AttachmentsOk/MinSenderTrust` |
| Status endpoint (heartbeat payload on request) | `AgentService` status endpoint; caller `Agent.GetStatusAsync` |
| Heartbeats `agents.hb.{agent}.{owner}.{instance}` every `interval` | `AgentService` timer; caller `HeartbeatTracker` (`agents.hb.*.*.*`) |
| Liveness: online while `now - last_seen < interval × 3` | `HeartbeatTracker.GetLiveness`, `AgentProtocol.LivenessSlack` |
| Discovery `$SRV.PING.agents` / `$SRV.INFO.agents`, stall-based collection | `AgentsClient.DiscoverAsync/EnumerateAsync` (stall 750 ms, max 2 s) |
| Token validation | `AgentSubject.IsValidToken`, `InvalidSubjectTokenException` |

## Prompt request and response stream

| Spec | .NET |
| --- | --- |
| Request body: plain text, or a JSON envelope `{prompt, attachments:[{filename, content(base64)}], …extras}` | `PromptEnvelope` (`Encode`/`Decode`). Attachments are MEAI `DataContent`: `Name` is the filename, `MediaType` is inferred from the extension (`AttachmentMediaTypes`). Unknown top-level keys round-trip in `Extras`. |
| Strict base64 | `PromptEnvelope.DecodeStrictBase64`, checked against `test-fixtures/attachments/base64-content.json` |
| §5.4 pre-publish checks (`attachments_ok`, `max_payload` incl. headers) | `Agent.PromptAsync` throws `AttachmentsNotSupportedException` / `PayloadTooLargeException` |
| Chunks `{"type":"response","text",attachments?}`, `{"type":"status","status"}`, `{"type":"query",…}` | `AgentChunkCodec`, records `AgentResponseChunk` / `AgentStatusChunk` / `AgentQueryChunk` |
| Empty-body terminator | `AgentChunkCodec.Terminator`; ends the caller's `IAsyncEnumerable` |
| `ack` status first | Hidden by default (`PromptOptions.IncludeAcks`) |
| Error frame: headers `Nats-Service-Error-Code` / `Nats-Service-Error` | Caller: `AgentServiceException(Code, Description)`. Host: throw `RequestRejectedException(code, description)`. Unhandled exceptions become 500. |
| Inactivity timeout (default 60 s) and absolute max wait (default 10 min) | `StreamStalledException` / `StreamMaxWaitExceededException`, `PromptOptions` |
| No responders | `NoRespondersException` |
| Empty prompt is invalid | Caller: `PromptAsync` throws `PromptEmptyException` before sending. Host: `PromptEnvelope.Decode` rejects a zero-byte body or an empty `prompt` with `InvalidEnvelopeException`, answered as a 400 error frame. |

The caller subscribes to the reply inbox with `NatsSubChannelOpts { FullMode = Wait }`. NATS.Net 3 defaults to
`DropNewest`, which would silently drop chunks of a fast stream.

## Mid-stream queries (§7)

| Spec | .NET |
| --- | --- |
| Host publishes `{"type":"query","id","reply","prompt",attachments?}` and waits on its reply subject | `PromptStream.AskAsync(prompt, attachments, timeout)` returns the caller's `PromptEnvelope`, or throws `AgentQueryTimeoutException` |
| Caller answers once on `reply` | `AgentQueryChunk.ReplyAsync` (string or envelope). A second reply throws `QueryAlreadyRepliedException`. |
| Host checks the caller is still there | `PromptStream.IsCallerListeningAsync` |

## Microsoft.Extensions.AI seams

### Caller

- `Agent.AsIChatClient()` returns `AgentChatClient : IChatClient`.
- **Request:** only the newest user `ChatMessage` is sent. Its `TextContent` becomes the prompt and its `DataContent`
  becomes attachments. `ChatOptions.AdditionalProperties` are sent as envelope extras (§5.3). The agent owns
  conversation state.
- **`ConversationId`** is the agent's prompt subject, or `ChatOptions.ConversationId` when the caller set one. A
  caller-set id (other than the prompt subject) is sent as the `session_id` envelope extra
  (`PromptEnvelope.SessionIdExtra`). This is a .NET convention, not a protocol field: hosts in other languages see an
  ordinary extra, and the .NET serve helpers key their conversations on it (`PromptContext.SessionId`).
- **Response chunks:** `response` becomes `TextContent` plus `DataContent`.
- **Status chunks** become `AgentStatusContent : AIContent`. `IncludeStatus` defaults to true. The same string is
  also mirrored in `AdditionalProperties["synadia.status"]`.
- **Queries** become `AgentQueryContent : InputRequestContent`, with `ReplyAsync(string | PromptEnvelope |
  ChatMessage)`. Alternatively, set `AgentChatClientOptions.QueryHandler` to answer inline.

### Host

- `PromptContext.ToChatMessage()` turns the prompt into a user `ChatMessage` (text plus `DataContent`).
- `PromptStream.WriteAsync(ChatResponseUpdate)` maps content to chunks:
  - `TextContent` and `DataContent` become `response`.
  - `AgentStatusContent`, or a content-less update with `AdditionalProperties["synadia.status"]` (a string), becomes
    `status`.
  - `TextReasoningContent` becomes `status` only when `includeReasoning` is set.
  - Function-call and function-result content is not forwarded.
- `AgentService.ServeChatClient(IChatClient, ChatClientServeOptions)` hosts any chat client as an agent:
  - History: one conversation per `session_id` extra (`PromptContext.SessionId`), or one shared conversation when the
    caller sends none. Override the key with `ConversationKey` (for example per sender), or turn history off with
    `KeepHistory = false`. When the inner client returns a `ConversationId` (a stateful service), only the newest id
    is kept and later calls send just the new messages with `ChatOptions.ConversationId`; otherwise the messages are
    kept in memory, capped at `MaxHistoryMessages`. Set `KeepHistory = false` for agents whose
    prompts carry large attachments (documents, images), otherwise every stored attachment is re-sent to the model on
    each later prompt.
  - Optional instructions.
  - The streaming output goes through `WriteAsync(ChatResponseUpdate)`.
  - **Tool approval to query round trip.** A `ToolApprovalRequestContent` from the model pipeline (for example
    `ApprovalRequiredAIFunction` under `FunctionInvokingChatClient`) is asked of the caller as a §7 query. The answer
    goes back as a `ToolApprovalResponseContent` and the model call resumes, for up to `MaxInputRounds`. The same
    seam is public as `PromptStream.AskApprovalAsync` (customize with `ToolApprovalOptions`; a timeout denies).
  - **Query relay.** An `AgentQueryContent` streamed by the inner client (a remote agent behind `AsIChatClient()`)
    is asked of this prompt's caller and answered in-stream, so `ServeChatClient(remote.AsIChatClient())` is a proxy.
  - `ChatClientServeOptions.AgentTools` lets the model prompt other agents. Each prompt runs in its own AgentTools
    call scope, attributed to the verified sender.

### MEAI 11.0.0 API spike (plan §1.1) — findings

| Question | Finding | Consequence |
| --- | --- | --- |
| Is `InputRequestContent` non-sealed and stable? | Non-sealed and GA in 11.0.0 (as is `InputResponseContent`). | `AgentQueryContent` derives from it, as designed. |
| Can we subclass `ToolApprovalRequestContent`? | Sealed (GA), and so is `ToolApprovalResponseContent`. | Approvals are not modelled as queries on the caller side. On the host, `ServeChatClient` translates approvals to and from queries. |
| `ApprovalRequiredAIFunction` | Sealed GA wrapper. | Usable as-is for the approval demo (`agent-sdk/dotnet/examples/06-approvals.cs`). |
| Can `AIFunction` report a verbatim JSON schema? | `AIFunctionDeclaration.JsonSchema`, `Name` and `Description` are virtual. | `AgentToolFunction` returns the fixture schema verbatim (byte-equal tests). |
| Is `FunctionInvokingChatClient` in Abstractions? | No, it is in `Microsoft.Extensions.AI`. | The core does not depend on it. `AgentToolFunction` has no tool-call id, so detached-call ids are generated. Hosts add `.UseFunctionInvocation()` themselves. |
| `AIJsonUtilities.DefaultOptions` | Writes indented JSON. | Wire JSON uses our own source-generated contexts and `Utf8JsonWriter`, never MEAI's options. |
| Portable reasoning control | `ChatOptions.Reasoning` / `ReasoningEffort` exist in 11.0.0. | The Ollama demo uses `ReasoningEffort.None` (qwen3.5 otherwise thinks for minutes). OllamaSharp 5.5.2 maps it to Ollama's native `think: false`, which was checked by capturing the `/api/chat` request body, so no provider-specific `RawRepresentationFactory` is needed. |
| Ollama client | OllamaSharp 5.5.2 is the newest release. It is compiled against MEAI.Abstractions 10.8 and binds to 11.0.0 at runtime with no load errors. | `agent-sdk/dotnet/examples/06-approvals.cs` uses `OllamaApiClient` as its `IChatClient` (`Microsoft.Extensions.AI.Ollama` is deprecated). |

## Sender identity (§13, additive)

| Spec | .NET |
| --- | --- |
| `Agent-Sender` header (Ed25519 over the canonical request) | Caller: `AgentsClientOptions.Identity = new SenderIdentityOptions { Signer = SenderSigner.FromCredsFile(path) }` (also `FromSeed`, `FromCreds`, `FromSeedAndJwt`; optional `Name`, `SendUnsignedClaim`). `PromptOptions.Sub` sets the per-prompt `sub`. Codec: `AgentSenderHeader`. |
| Caller's own id (`$SYS.REQ.USER.INFO`) | `AgentsClient.GetSelfIdAsync()` returns an `AgentId` (`{account}.{user}`) |
| Host verification (signature, subject binding, `ts` replay window, nonce) | `SenderHeader.Verify(...)`, run by `AgentService` for every prompt. Options: `ReplayWindow`, `AcceptSender` hook, `OperatorAttested`, `AccountTokenPosition`. |
| Host trust policy `min_sender_trust` (`any` / `signed`) | `AgentServiceOptions.MinSenderTrust`. Rejections are answered with a §9 error frame (400 malformed header, 401 signature required or invalid, 403 refused by `AcceptSender`, 500 internal). The classified sender is `PromptContext.Sender` (`VerifiedSender` or `ClaimedSender`). |
| Agent-side signing of discovery metadata (`id_sig`) | Host: `AgentServiceOptions.Identity = new AgentServiceIdentityOptions { Signer = ... }`. Caller: `AgentIdSignature.Verify(metadata, promptSubject)`; `AgentTools` reports it as `identity_verified`. |
| Fixtures | Every vector in `test-fixtures/identity/*vectors*.json` passes. |

Not ported yet: the pluggable account resolver, a shared (cross-instance) nonce cache, and Stored-mode operator
attestation. Two spec ambiguities: non-ASCII `name` values may be mangled in NATS headers by `NATS.Client.Core`, and
.NET parses `ts` strictly against the header timestamp format (`SenderHeader.ParseTimestamp`).

## Agent tools

| Contract (`docs/agent-tools.md`) | .NET |
| --- | --- |
| Six tool definitions (shared JSON) | `AgentToolDefinitions` (embedded copies of `test-fixtures/agent-tools/*.json`, with a test that they are equal) |
| Blocking variant (no `wait_agent`) | `AgentToolDefinitions.Offered(…)` |
| Executor | `AgentTools.ExecuteAsync(name, args, toolCallId)` returns a `JsonObject` result |
| MEAI | `AgentTools.AsAITools()` returns `AIFunction`s whose `JsonSchema` is the fixture text |
| Per-prompt scope, loop guard, caller attribution | `AgentTools.RunInPromptScopeAsync`, `AgentToolsOptions.SelfAddress` |
| Returned attachments saved under roots, deterministic names | `AttachmentSaver` (`test-fixtures/attachments/save-names.json`) |
| Extensions | `AgentToolsExtension` (discovery fields, prompt rewrite, reply fields) |

## Deliberate divergences from the TS/Python SDKs

- **Attachments are decoded eagerly** into `DataContent`. TS keeps them lazy.
- **Lone UTF-16 surrogates** (for example a filename containing `\ud800`) are rejected by System.Text.Json, so such an
  envelope fails to decode in .NET while TS/Python accept it. The shared fixture row is checked with a lenient
  unescape in the tests.
- **`PromptAsync` is lazy:** nothing is sent until enumeration starts, and send errors surface from the enumerator.
- **No caller interceptors.** Envelope extensions travel in `PromptEnvelope.Extras` (and `EnvelopeExtras` for agent
  tools).
- **No separate `discoverTimeoutMs`.** Discovery uses `DiscoverStall` / `DiscoverMaxWait`.
- **No synthesized `done` status** at the terminator. The end of the `IAsyncEnumerable` is the signal.
- **Host handlers** are `PromptHandler(PromptContext, PromptStream, CancellationToken)`.
  - The SDK writes the terminator.
  - Exceptions map to error frames: `RequestRejectedException` keeps its code, anything else is a 500.
