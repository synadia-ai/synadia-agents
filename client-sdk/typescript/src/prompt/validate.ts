// Pure: local validation per spec §5.4. These checks MUST run before the
// request hits the wire; failing here saves a round trip and agent resources.

import type { EndpointInfo } from "../discovery/endpoint-info.js";
import { AttachmentsNotSupportedError, PayloadTooLargeError, PromptEmptyError } from "../errors.js";

export function assertPromptNonEmpty(text: string): void {
  if (text.length === 0) throw new PromptEmptyError();
}

export function assertAttachmentsAllowed(
  attachmentsPresent: boolean,
  endpoint: EndpointInfo,
): void {
  if (!attachmentsPresent) return;
  if (endpoint.attachmentsOk === false) throw new AttachmentsNotSupportedError();
}

export function assertWithinMaxPayload(encodedByteSize: number, endpoint: EndpointInfo): void {
  const limit = endpoint.maxPayloadBytes;
  if (limit === undefined) return; // endpoint didn't declare a limit
  if (encodedByteSize > limit) {
    throw new PayloadTooLargeError(limit, encodedByteSize);
  }
}
