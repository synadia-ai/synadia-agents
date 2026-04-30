"""SDK-owned reply-inbox prefix.

Held constant across language SDKs so operators can grant a single
permission (``_INBOX.agents.>``) covering every caller-side reply
subject created by an agents SDK, regardless of language. Not
user-overridable: the prefix is part of the SDK's observable behavior,
not a configuration knob — :meth:`nats.aio.client.Client.new_inbox`
is intentionally bypassed in favor of this helper everywhere the SDK
allocates a reply subject.
"""

from __future__ import annotations

import os

from nats.nuid import NUID

SDK_INBOX_PREFIX = "_INBOX.agents"

_nuid = NUID()

# After fork() the child inherits the parent's NUID state and would mint
# identical inboxes until its sequence ticked past the parent's. Re-roll
# the prefix in the child so its inbox stream is disjoint. POSIX-only;
# Windows has no fork to defend against.
if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_nuid.randomize_prefix)


def new_inbox() -> str:
    return f"{SDK_INBOX_PREFIX}.{_nuid.next().decode()}"
