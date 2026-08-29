"""Every rendered identity carries its trust class (SDK convention, spec "SHOULD").

A claim must never read as proof in a log line or a console.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .sender_header import SenderInfo


def format_sender(sender: SenderInfo | None) -> str:
    """Render a classified sender with its trust class next to the id.

    - ``<account>.<user> (verified)`` — signature verified AND the account
      attested by a server stamp (operator-attested mode; host package);
    - ``<account>.<user> (verified user, claimed account)`` — signature
      verified; ``account`` is the sender's signed word;
    - ``<account>.<user> (claimed)`` — unsigned claim;
    - ``(no sender)`` — no header / unknown ``v``.
    """
    if sender is None:
        return "(no sender)"
    if sender.trust == "verified":
        if sender.account_attested:
            return f"{sender.id} (verified)"
        return f"{sender.id} (verified user, claimed account)"
    return f"{sender.claim.account}.{sender.claim.user} (claimed)"


__all__ = ["format_sender"]
