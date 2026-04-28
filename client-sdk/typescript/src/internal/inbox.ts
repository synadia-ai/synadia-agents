// SDK-owned reply-inbox prefix. Held constant across language SDKs so
// operators can grant a single permission (`_INBOX.agents.>`) covering
// every caller-side reply subject created by an agents SDK, regardless
// of language. Not user-overridable: the prefix is part of the SDK's
// observable behavior, not a configuration knob.

import { createInbox } from "@nats-io/nats-core";

export const SDK_INBOX_PREFIX = "_INBOX.agents";

export function newInbox(): string {
  return createInbox(SDK_INBOX_PREFIX);
}
