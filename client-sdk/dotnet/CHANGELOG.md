# Changelog — Synadia.AI.Agents (.NET caller SDK)

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Initial .NET caller SDK for wire protocol v0.3 (`0.1.0-preview.1`, targeting net8.0 and net10.0).
  - **Discovery and liveness.** Discovery uses `$SRV.PING/INFO.agents` (`AgentsClient.DiscoverAsync`,
    `EnumerateAsync`, `LookupAsync`, `PingAsync`). Liveness comes from `agents.hb.*.*.*` (`HeartbeatTracker`).
    Status is available through `Agent.GetStatusAsync`.
  - **Prompting.** `Agent.PromptAsync` returns `IAsyncEnumerable<AgentChunk>`, with inactivity and max-wait timeouts.
    Error frames become `AgentServiceException`. The reply inbox is subscribed in `Wait` full mode, so no chunk is
    dropped. `GetResponseAsync` and `GetResponseTextAsync` are aggregating helpers. Empty prompts are rejected
    locally with `PromptEmptyException`.
  - **Attachments.** The JSON envelope (`PromptEnvelope`) carries attachments as MEAI `DataContent`, with strict
    base64. The §5.4 pre-publish checks raise `AttachmentsNotSupportedException` and `PayloadTooLargeException`.
  - **Mid-stream queries (§7).** `AgentQueryChunk.ReplyAsync` answers them.
  - **Microsoft.Extensions.AI seams.** `Agent.AsIChatClient()` returns an `IChatClient`. Status arrives as
    `AgentStatusContent` and queries as `AgentQueryContent : InputRequestContent`; answer one with `ReplyAsync` or
    with `AgentQueryContent.CreateResponse(text, attachments)`, which returns an `AgentQueryResponseContent`.
  - **Conversations.** `AsIChatClient()` honors `ChatOptions.ConversationId`: a caller-set id is sent as the
    `session_id` envelope extra (`PromptEnvelope.SessionIdExtra`, read back with `PromptEnvelope.SessionId`) and
    echoed as the response `ConversationId`. A .NET convention, not a protocol change.
  - **Sender identity (§13).** `Agent-Sender` is signed and verified with Ed25519 via NATS.NKeys and checked against
    `test-fixtures/identity` vectors. Callers sign with `AgentsClientOptions.Identity` (`SenderSigner.FromCredsFile`,
    `FromSeed`, …), read their own id with `AgentsClient.GetSelfIdAsync`, and verify an agent's `id_sig` with
    `AgentIdSignature.Verify`.
  - **Agent tools.** `AgentTools` ports the TS/Python agent-tools helper, and `AgentTools.AsAITools()` exposes its
    six tools as `AIFunction`s. Their schemas are byte-equal to `test-fixtures/agent-tools`. `AttachmentSaver` saves
    returned attachments. `discover_agents` reports `identity` and `identity_verified`.
  - **Packaging.** A consumer `PACKAGE.md` README, SourceLink, `.snupkg` symbols and deterministic CI builds. Public
    API baselines are enforced by PublicApiAnalyzers; RS0016/RS0017 fail the build.
  - Solution file `Synadia.AI.Agents.slnx` (needs .NET SDK 9.0.200 or later; the repo pins 10.0.100).
  - Numbered examples `01-discover` through `06-chat`, as .NET 10 file-based apps.