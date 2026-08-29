"""``Nats-Request-Info`` — the stamp the server writes on a request that crosses a service import.

The stamp carries ``acc`` (the caller's account as the server names it)
and, behind a ``share: true`` import, ``user`` (the caller's user public
key). On an open endpoint a receiver cannot tell that stamp from a
forgery (spec "How we transport the agent identity on the wire":
same-account traffic carries a client-written header verbatim), so the
SDK reads it **only in operator-attested mode** (spec Appendix A), where
the deployment declared the endpoint closed. Everywhere else the header
is never looked at.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass

#: The header name — matched case-sensitively.
NATS_REQUEST_INFO_HEADER = "Nats-Request-Info"


@dataclass(frozen=True, slots=True)
class RequestInfoStamp:
    """The two identity fields of a server stamp; everything else is ignored."""

    #: ``acc`` — the account public key on an operator-mode server, the
    #: configured name otherwise. Present on every stamp.
    account: str | None = None
    #: ``user`` — the caller's user public key. Present only behind a ``share: true`` import.
    user: str | None = None


def parse_request_info(value: str) -> RequestInfoStamp | None:
    """Parse a header value; ``None`` when it is not what the server would write.

    Not a JSON object, or ``acc`` / ``user`` present but not strings →
    ``None``. Unknown fields (``rtt``, ``server``, ``jwt``, ``issuer_key``,
    …) are ignored.

    Deliberately no size cap (unlike :func:`parse_sender_header`'s 2 KiB):
    behind a ``share: true`` import the server's stamp embeds the caller's
    whole user JWT, which grows with its permission lists — a cap would
    refuse legitimate stamps. The value is only ever parsed under
    operator-attested mode, where it is the server's, and the broker's
    ``max_payload`` bounds it.
    """
    try:
        parsed = json.loads(value)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    o: dict[str, object] = parsed
    if "acc" in o and not isinstance(o["acc"], str):
        return None
    if "user" in o and not isinstance(o["user"], str):
        return None
    acc = o.get("acc")
    user = o.get("user")
    return RequestInfoStamp(
        account=acc if isinstance(acc, str) else None,
        user=user if isinstance(user, str) else None,
    )


def read_request_info(
    headers: Mapping[str, object] | None,
) -> tuple[bool, RequestInfoStamp | None]:
    """Read the stamp from message headers as ``(present, stamp)``.

    ``(False, None)`` when the header is absent; ``(True, None)`` when it
    is present but malformed — or present more than once, which the
    server never produces (over nats-py repeated names collapse into one
    value, so that row is reachable only with a raw ``list`` value);
    ``(True, stamp)`` otherwise. Exact-case header name.
    """
    if not headers:
        return (False, None)
    value = headers.get(NATS_REQUEST_INFO_HEADER)
    if value is None:
        return (False, None)
    if isinstance(value, list | tuple):
        if len(value) == 0:
            return (False, None)
        if len(value) > 1:
            return (True, None)
        value = value[0]
    if not isinstance(value, str):
        return (True, None)
    return (True, parse_request_info(value))


__all__ = [
    "NATS_REQUEST_INFO_HEADER",
    "RequestInfoStamp",
    "parse_request_info",
    "read_request_info",
]
