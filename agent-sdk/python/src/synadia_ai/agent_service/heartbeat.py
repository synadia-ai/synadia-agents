"""Heartbeat publisher half — agent-side per protocol §8.

Periodically emits a §8.3 :class:`~synadia_ai.agents.HeartbeatPayload`
on the agent's heartbeat subject. The wire shape, the
``HeartbeatTracker`` (caller-side), and the ``now_iso`` helper live in
:mod:`synadia_ai.agents`; this module owns only the *publishing*
side and the ``build_heartbeat_payload`` helper that the
:class:`~synadia_ai.agent_service.AgentService` status handler reuses
to ensure heartbeat and status responses share the exact same payload
construction path.

An agent's presence on the fabric is its signed heartbeat: with a
:class:`HeartbeatSigner` the publisher sets the same ``Agent-Sender``
header the SDK puts on its edge records on every heartbeat — ``sub`` the
heartbeat subject as published, ``ts`` the heartbeat's own ``ts``, a
fresh nonce per beat, ``sig`` over subject · ts · nonce · sha256 of the
exact payload bytes published. No new payload field, no new signing
format: the header of the sender-identity extension, unchanged, signed
with the same signer that signs ``id_sig``. Without a signer the agent
beats unsigned, exactly as plain protocol 0.3 — a claim, never proof of
presence — and a 0.3 subscriber ignores headers either way.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING

from synadia_ai.agents import (
    AGENT_SENDER_HEADER,
    HeartbeatPayload,
    serialize_sender_header,
    sign_sender_header,
)
from synadia_ai.agents.heartbeat import now_iso

from ._logging import get_logger

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from synadia_ai.agents import AgentId, AgentSubject, SenderSigner

log = get_logger(__name__)

#: Reads the extra heartbeat fields when a beat is built, so a value that
#: moves between beats — a counter — is current on every one.
ExtrasProvider = Callable[[], Mapping[str, object]]

# The §8.3 field names. An extra under one of these would either shadow
# the real field or, as a duplicate keyword, blow up construction with a
# TypeError; refused up front with a message that names the key instead.
_RESERVED_KEYS = frozenset(HeartbeatPayload.model_fields)


@dataclass(frozen=True, slots=True)
class HeartbeatSigner:
    """Who signs the heartbeats: the host's agent ID and the signer over its user NKEY seed."""

    id: AgentId
    signer: SenderSigner


async def sign_heartbeat(
    sender: HeartbeatSigner,
    subject: str,
    data: bytes,
    ts: str,
    *,
    nonce: str | None = None,
) -> dict[str, str]:
    """The message headers of one heartbeat: exactly one ``Agent-Sender``, signed.

    ``subject`` is the heartbeat subject as published, ``data`` the exact
    payload bytes published (the signature binds their SHA-256) and ``ts``
    the heartbeat's own ``ts`` — the header carries the same instant.
    ``nonce`` is an override for tests and vectors; a fresh NUID otherwise.
    """
    header = await sign_sender_header(
        signer=sender.signer,
        id=sender.id,
        sub=subject,
        payload=data,
        ts=ts,
        nonce=nonce,
    )
    return {AGENT_SENDER_HEADER: serialize_sender_header(header)}


def build_heartbeat_payload(
    subject: AgentSubject,
    interval_s: int,
    instance_id: str,
    extras: Mapping[str, object] | None = None,
) -> HeartbeatPayload:
    """Construct a §8.3 heartbeat payload for ``subject``.

    Pure helper shared between the heartbeat publisher and the v0.3
    ``status`` request/response endpoint — both emit the same payload
    shape, and richer agent metadata added in future PRs lands here in
    one place.

    ``extras`` are forward-compat fields merged into the wire payload
    alongside the §8.3 ones (the TypeScript encoder's ``extras`` slot).
    A key that reuses a §8.3 field name raises ``ValueError``.
    """
    if extras:
        clash = sorted(_RESERVED_KEYS.intersection(extras))
        if clash:
            raise ValueError(
                f"heartbeat extras must not reuse the §8.3 field names {clash}; "
                "those are set from the subject and the service"
            )
    return HeartbeatPayload(
        agent=subject.agent,
        owner=subject.owner,
        session=subject.session_name,
        instance_id=instance_id,
        ts=now_iso(),
        interval_s=interval_s,
        **(extras or {}),
    )


async def publish_one(
    nc: NATSClient,
    subject: AgentSubject,
    interval_s: int,
    instance_id: str,
    extras: Mapping[str, object] | None = None,
    *,
    sender: HeartbeatSigner | None = None,
) -> None:
    """Publish a single heartbeat frame to the agent's heartbeat subject.

    With ``sender`` the frame carries its signed ``Agent-Sender`` header
    (see :func:`sign_heartbeat`); without one it goes out bare, as plain
    protocol 0.3. A signer that fails mid-life (a wiped key) costs the beat
    its signature, never the beat: 0.3 callers keep seeing liveness, and
    the fabric — which counts an unsigned beat as a claim — shows the agent
    as down until signing works again. Logged on every beat.
    """
    payload = build_heartbeat_payload(subject, interval_s, instance_id, extras)
    data = payload.model_dump_json().encode("utf-8")
    headers: dict[str, str] | None = None
    if sender is not None:
        try:
            headers = await sign_heartbeat(sender, subject.heartbeat, data, payload.ts)
        except Exception:
            log.exception("heartbeat signing failed for %s; publishing unsigned", subject.inbox)
    await nc.publish(subject.heartbeat, data, headers=headers)


async def run_publisher(
    nc: NATSClient,
    subject: AgentSubject,
    interval_s: int,
    instance_id: str,
    stop: asyncio.Event,
    extras: ExtrasProvider | None = None,
    *,
    sender: HeartbeatSigner | None = None,
) -> None:
    """Periodically publish heartbeats until `stop` is set.

    ``sender``, when given, signs every beat (see :func:`publish_one`).
    ``extras``, when given, is called before each beat for the extra
    fields to carry on it (see :func:`build_heartbeat_payload`). A
    provider that raises, or extras the payload cannot carry (a reserved
    key, a value that does not serialise), cost that beat its extras and
    nothing more: the beat still goes out, the failure is logged, and the
    publisher keeps running — a bad extra must never take the agent's
    liveness down with it.

    A failed publish (e.g. ``ConnectionClosedError`` after a broker
    restart) MUST NOT crash the publisher task with a non-cancellation
    exception: that would (a) make the agent go dark while the micro
    service still appears registered, and (b) cause :meth:`AgentService.stop`
    to re-raise on teardown. The publisher logs the failure and exits
    cleanly so ``stop()`` can complete; the surrounding service decides
    whether to recover.
    """
    log.debug("heartbeat publisher starting for %s (interval=%ss)", subject.inbox, interval_s)

    async def beat() -> None:
        fields: Mapping[str, object] | None = None
        if extras is not None:
            try:
                fields = extras()
            except Exception:
                log.exception("heartbeat extras provider failed; publishing without extras")
        try:
            await publish_one(nc, subject, interval_s, instance_id, fields, sender=sender)
        except (TypeError, ValueError) as exc:
            # A reserved key or an unserialisable value — a fault in the
            # extras, not in the transport (pydantic's serialisation error
            # is a ValueError). Transport errors propagate to the caller.
            if fields is None:
                raise
            log.error("heartbeat extras rejected (%s); publishing without extras", exc)
            await publish_one(nc, subject, interval_s, instance_id, sender=sender)

    try:
        # Emit one heartbeat immediately so callers that subscribe-then-discover
        # observe liveness without waiting a full interval (§8.5).
        await beat()
        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=interval_s)
            if stop.is_set():
                break
            await beat()
    except Exception:
        log.exception("heartbeat publisher failed for %s; exiting", subject.inbox)
        return
    log.debug("heartbeat publisher stopped for %s", subject.inbox)


__all__ = [
    "ExtrasProvider",
    "HeartbeatSigner",
    "build_heartbeat_payload",
    "publish_one",
    "run_publisher",
    "sign_heartbeat",
]
