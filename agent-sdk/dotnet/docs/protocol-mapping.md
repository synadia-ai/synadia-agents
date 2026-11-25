# Protocol mapping — .NET host SDK

The caller and host SDKs share one mapping document, because the envelope, chunk, identity and MEAI types live in the
caller package:
[`client-sdk/dotnet/docs/protocol-mapping.md`](../../../client-sdk/dotnet/docs/protocol-mapping.md).

## Host-specific summary

| Spec | .NET host |
| --- | --- |
| §3 Service registration (`agents`, metadata, prompt + status endpoints, queue group `agents`) | `AgentService.StartAsync` |
| §4 Heartbeats on `agents.hb.{agent}.{owner}.{instance}` | `AgentServiceOptions.HeartbeatInterval` (default 30 s), `HeartbeatExtras` |
| §5 Prompt envelope (text or JSON with base64 attachments) | `PromptContext.Envelope` / `Prompt` / `Attachments` (`DataContent`) / `Extras`. An empty body or empty `prompt` gets a 400 error frame plus the terminator, and the handler is not called. |
| §6 Streaming chunks and empty terminator | `PromptStream.WriteAsync` / `WriteStatusAsync`. The terminator is written by the SDK after the handler returns. |
| §7 Mid-stream query | `PromptStream.AskAsync` (timeout from `DefaultQueryTimeout`) |
| §9 Error frame | `throw new RequestRejectedException(code, description)`. Other exceptions become 500. |
| §13 Sender identity | `AgentServiceOptions.MinSenderTrust` (`"any"` / `"signed"`), `AcceptSender` hook, `PromptContext.Sender`. Rejections: 400 malformed header, 401 signature required or invalid, 403 hook returned false, 500 hook threw. |
| Conversation memory (`ServeChatClient`) | `ChatClientServeOptions.KeepHistory` (default `true`). Set `false` for attachment-heavy agents so base64 payloads are not replayed. |
| Keep-alive while a handler is busy | `AgentServiceOptions.KeepAliveInterval` (default 30 s) |
| Graceful stop | `StopAsync` / `DisposeAsync` drain in-flight prompts for up to `DrainTimeout` |
| MEAI | `PromptContext.ToChatMessage()`, `PromptStream.WriteAsync(ChatResponseUpdate)`, `ServeChatClient(IChatClient)` |
