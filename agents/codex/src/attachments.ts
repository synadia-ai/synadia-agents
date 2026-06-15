import { ProtocolError, type RequestEnvelope } from "@synadia-ai/agents";

export function rejectUnsupportedAttachments(envelope: RequestEnvelope): void {
  if ((envelope.attachments?.length ?? 0) > 0) {
    throw new ProtocolError("attachments are not supported by the Codex NATS adapter v1");
  }
}
