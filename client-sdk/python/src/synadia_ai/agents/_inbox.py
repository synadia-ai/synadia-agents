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

from nats.nuid import NUID

SDK_INBOX_PREFIX = "_INBOX.agents"

_nuid = NUID()

try:
    import os as _os
    _os.register_at_fork(after_in_child=_nuid.randomize)
except AttributeError:
    pass  # register_at_fork not available on Windows


def new_inbox() -> str:
    return f"{SDK_INBOX_PREFIX}.{_nuid.next().decode()}"
