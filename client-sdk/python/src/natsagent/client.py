"""Caller-side API — discover, bind, ping, stream prompts.

The :class:`Client` wraps a NATS connection and tracks agent liveness via
heartbeats (§8). :meth:`Client.discover` returns every protocol-compliant
agent currently registered; :meth:`Client.bind` returns a :class:`RemoteAgent`
for prompting. The SDK subscribes to the heartbeat wildcard BEFORE running
discover so no agent is missed between the ping response and its first beacon
(§8.5).
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, TypeAlias

from ._bytes import InvalidSizeError, parse_human_bytes
from ._logging import get_logger
from .envelope import Attachment, Envelope, encode
from .errors import AgentNotFound, ProtocolError
from .heartbeat import AgentStatus, HeartbeatTracker
from .messages import QueryChunk, ResponseChunk, StatusChunk, decode_chunk
from .subjects import parse_agent_subject
from .validation import (
    assert_attachments_allowed,
    assert_prompt_non_empty,
    assert_within_max_payload,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

log = get_logger(__name__)


@dataclass(frozen=True)
class Query:
    """A mid-stream question from the agent (§7).

    Yielded by the prompt iterator when the agent publishes a ``query`` chunk.
    Call :meth:`reply` exactly once to answer — the SDK publishes to
    ``reply_subject`` fire-and-forget (no agent ack, per §7.2).
    """

    id: str
    reply_subject: str
    prompt: str
    attachments: list[Attachment] | None
    _nc: NATSClient = field(repr=False)

    async def reply(self, answer: str | Envelope) -> None:
        """Send the caller's reply to this query (§7.2).

        ``str`` is sent via the §5.3 plain-text shorthand; an :class:`Envelope`
        is JSON-encoded. Multiple calls are a bug — §7.2 specifies exactly
        one reply per ``reply_subject``.
        """
        if isinstance(answer, str):
            payload = answer.encode("utf-8")
        elif isinstance(answer, Envelope):
            payload = encode(answer)
        else:
            raise TypeError(f"unsupported answer type: {type(answer).__name__}")
        await self._nc.publish(self.reply_subject, payload)


StreamMessage: TypeAlias = ResponseChunk | StatusChunk | Query
"""One item yielded by :meth:`RemoteAgent.prompt`'s async iterator."""


@dataclass(frozen=True, slots=True)
class EndpointInfo:
    """Parsed endpoint record from ``$SRV.INFO`` (§2.1, §4.3).

    ``max_payload_bytes`` and ``attachments_ok`` are populated only when the
    endpoint declared them (the protocol requires both on the ``prompt``
    endpoint per §2.1). Unparseable ``max_payload`` values leave the field
    ``None``; the raw string remains in ``metadata`` per §5.6.
    """

    name: str
    subject: str
    metadata: Mapping[str, str]
    max_payload_bytes: int | None = None
    attachments_ok: bool | None = None


@dataclass(frozen=True, slots=True)
class DiscoveredAgent:
    """One entry in the result of :meth:`Client.discover`.

    ``inbox`` is the full NATS subject reported by ``$SRV.INFO`` for the
    ``prompt`` endpoint — use it to :meth:`Client.bind`. ``service_id`` is
    the NATS micro service instance id, useful for distinguishing multiple
    running instances of the same identity tuple (§3.3) and for correlating
    ``$SRV.INFO.SynadiaAgents.{instance_id}`` lookups (§4.2) and heartbeat
    ``instance_id`` values (§8.3).

    ``agent`` matches ``metadata.agent`` from the $SRV.INFO response (§3.2)
    and the 2nd subject token (§2). ``name`` is derived from the 4th
    subject token when the prompt endpoint uses the default subject layout
    (§4.3); it is ``""`` for custom endpoint subjects.
    """

    name: str
    agent: str
    owner: str
    inbox: str
    service_id: str
    description: str
    prompt_endpoint: EndpointInfo
    session: str | None = None


class Client:
    """Caller-side entry point. One per application; wraps a NATS connection."""

    def __init__(self, nc: NATSClient) -> None:
        self._nc = nc
        self._tracker = HeartbeatTracker(nc)
        self._started = False

    async def start(self) -> None:
        """Subscribe to the heartbeat wildcard. Idempotent; :meth:`discover` calls this."""
        if self._started:
            return
        await self._tracker.start()
        self._started = True

    async def stop(self) -> None:
        await self._tracker.stop()
        self._started = False

    async def discover(self, *, timeout: float = 2.0) -> list[DiscoveredAgent]:
        """Enumerate agents via ``$SRV.INFO.SynadiaAgents`` (§4).

        §4.1 defines two stable discovery subjects; we use ``$SRV.INFO`` so
        each response carries its endpoints (§4.3 requires callers to read
        the prompt endpoint's subject — it's not reconstructable from
        identity alone). The SDK does not auto-poll — ongoing liveness
        flows through the heartbeat stream (§8).
        """
        await self.start()  # subscribe-before-discover per §8.5
        inbox = self._nc.new_inbox()
        sub = await self._nc.subscribe(inbox)
        responses: list[bytes] = []
        try:
            await self._nc.publish(f"$SRV.INFO.{_DISCOVERY_NAME}", b"", reply=inbox)
            while True:
                try:
                    msg = await sub.next_msg(timeout=timeout)
                except TimeoutError:
                    break
                responses.append(msg.data)
        finally:
            await sub.unsubscribe()

        out: list[DiscoveredAgent] = []
        for data in responses:
            agent = _parse_srv_info_response(data)
            if agent is not None:
                out.append(agent)
        log.debug("discover() returned %d agent(s)", len(out))
        return out

    def bind(self, target: str | DiscoveredAgent) -> RemoteAgent:
        """Return a handle for prompting an agent.

        Pass a :class:`DiscoveredAgent` (as returned by :meth:`discover`) to
        get a fully-capability-aware handle — :meth:`RemoteAgent.prompt`
        will enforce ``max_payload`` / ``attachments_ok`` locally per §5.4.

        Pass a bare ``inbox`` string for the CLI / testing shortcut; the
        returned handle has no capability metadata and skips local §5.4
        enforcement. §12 flags construction-from-identity as a caller
        anti-pattern — prefer discovery in production code.
        """
        if isinstance(target, DiscoveredAgent):
            return RemoteAgent(self._nc, target.inbox, prompt_endpoint=target.prompt_endpoint)
        return RemoteAgent(self._nc, target, prompt_endpoint=None)

    async def ping(self, inbox: str, *, timeout: float = 2.0) -> bool:
        """On-demand reachability check via ``$SRV.PING.SynadiaAgents`` (§8.4).

        Returns ``True`` iff any Synadia agent responds within ``timeout``;
        the spec directs callers to correlate responses with heartbeats via
        ``instance_id`` for per-instance reachability (§8.4). This one-shot
        variant is satisfied by any response since the ``discover``-free
        caller is typically just asking "is the bus reachable and any
        compliant agent present?".
        """
        if parse_agent_subject(inbox) is None:
            raise AgentNotFound(f"not a valid agent inbox subject: {inbox}")
        try:
            await self._nc.request(f"$SRV.PING.{_DISCOVERY_NAME}", b"", timeout=timeout)
        except TimeoutError:
            return False
        return True

    def status(self, inbox: str) -> AgentStatus:
        """Return the passively-tracked heartbeat status for ``inbox``."""
        return self._tracker.status(inbox)


class RemoteAgent:
    """A bound agent — returned by :meth:`Client.bind`.

    When constructed from a :class:`DiscoveredAgent`, ``prompt_endpoint``
    carries the parsed §2.1 capability fields and :meth:`prompt` enforces
    §5.4 locally. When constructed from a bare inbox subject, no
    capability metadata is available and §5.4 enforcement falls to the
    agent side.
    """

    def __init__(
        self,
        nc: NATSClient,
        inbox: str,
        *,
        prompt_endpoint: EndpointInfo | None = None,
    ) -> None:
        self._nc = nc
        self.inbox = inbox
        self.prompt_endpoint = prompt_endpoint

    def prompt(
        self,
        text: str | Envelope,
        *,
        attachments: list[Attachment] | None = None,
        timeout: float = 60.0,
    ) -> AsyncIterator[StreamMessage]:
        """Send a prompt and return an async iterator of streamed messages.

        ``text`` is either a bare string or a fully-constructed
        :class:`Envelope`. ``attachments``, when provided, are attached to
        the envelope (per §5.1).

        §5.4 pre-publish validation runs synchronously before any wire I/O
        when the remote was bound from a :class:`DiscoveredAgent`. Failures
        raise:

        - :class:`PromptEmptyError` — empty prompt text (§5.1).
        - :class:`AttachmentsNotSupportedError` — attachments with
          ``attachments_ok=false`` (§5.4).
        - :class:`PayloadTooLargeError` — envelope exceeds ``max_payload``
          (§5.4).

        The iterator yields :class:`ResponseChunk` / :class:`StatusChunk` as
        the agent emits them and :class:`Query` when the agent asks a
        mid-stream question (§7) — the caller answers via
        ``await q.reply(...)`` without breaking the loop. The iterator
        terminates when the empty-payload chunk arrives (§6.5). Service
        errors mid-stream (§9) are raised as :class:`ProtocolError`.
        ``timeout`` is per-message: if no chunk arrives within ``timeout``
        seconds, the iterator raises.
        """
        if isinstance(text, Envelope):
            if attachments:
                existing = list(text.attachments or [])
                existing.extend(attachments)
                envelope = Envelope(prompt=text.prompt, attachments=existing)
            else:
                envelope = text
        else:
            envelope = Envelope(
                prompt=text,
                attachments=list(attachments) if attachments else None,
            )

        # §5.4: local validation happens synchronously BEFORE any wire I/O.
        # Raising here means callers don't even allocate a reply subject.
        encoded = encode(envelope)
        assert_prompt_non_empty(envelope.prompt)
        if self.prompt_endpoint is not None:
            assert_attachments_allowed(
                bool(envelope.attachments), self.prompt_endpoint.attachments_ok
            )
            assert_within_max_payload(len(encoded), self.prompt_endpoint.max_payload_bytes)

        return self._stream_prompt(envelope, encoded, timeout)

    async def _stream_prompt(
        self, envelope: Envelope, encoded: bytes, timeout: float
    ) -> AsyncIterator[StreamMessage]:
        del envelope  # retained for readability at the call site; not needed here
        reply = self._nc.new_inbox()
        sub = await self._nc.subscribe(reply)
        try:
            await self._nc.publish(self.inbox, encoded, reply=reply)
            while True:
                try:
                    msg = await sub.next_msg(timeout=timeout)
                except TimeoutError as exc:
                    raise ProtocolError(
                        f"stream stalled: no chunk received within {timeout}s on {reply}"
                    ) from exc

                headers = msg.headers or {}
                if "Nats-Service-Error-Code" in headers:
                    code = headers["Nats-Service-Error-Code"]
                    desc = headers.get("Nats-Service-Error", "")
                    raise ProtocolError(f"service error {code}: {desc}")

                if msg.data == b"" and not headers:
                    # §6.5: the terminator is a zero-byte body with NO headers.
                    # An empty body that carries headers (e.g. an error frame
                    # with no JSON context — §9.1) is explicitly not the
                    # terminator; §9.3 requires the error frame to precede
                    # the real empty-and-headerless terminator.
                    return
                chunk = decode_chunk(msg.data)
                if chunk is None:
                    # §6.6: unknown chunk types are silently ignored.
                    continue
                if isinstance(chunk, QueryChunk):
                    yield Query(
                        id=chunk.id,
                        reply_subject=chunk.reply_subject,
                        prompt=chunk.prompt,
                        attachments=(list(chunk.attachments) if chunk.attachments else None),
                        _nc=self._nc,
                    )
                else:
                    yield chunk
        finally:
            with contextlib.suppress(Exception):
                await sub.unsubscribe()


_ACCEPTED_SERVICE_NAMES = frozenset({"Synadia Agents", "SynadiaAgents"})
_DISCOVERY_NAME = "SynadiaAgents"
"""Compact form used in ``$SRV.{PING,INFO}.<name>`` subjects. Spec §3.1 allows
both ``Synadia Agents`` and ``SynadiaAgents``; subjects can't contain spaces,
so we ship the compact form on the wire and accept either in responses."""

# Default `prompt` endpoint subject is `agents.{agent}.{owner}.{name}` — 4 dot
# tokens (§2). Custom endpoint subjects break this pattern, in which case the
# instance name is opaque to the caller (§4.3).
_DEFAULT_INBOX_TOKEN_COUNT = 4


def _parse_srv_info_response(data: bytes) -> DiscoveredAgent | None:  # noqa: PLR0911
    """Parse one ``$SRV.INFO`` response; return None if not a compliant agent.

    Spec §3.1: agents register under service name ``"Synadia Agents"`` (or
    ``"SynadiaAgents"``). §3.2: metadata carries ``agent``, ``owner``,
    ``protocol_version``, and optionally ``session``. §4.3: callers read the
    prompt endpoint subject from the response — they MUST NOT reconstruct it
    from identity alone.

    Multiple early returns reflect the validation pipeline (unknown service,
    missing metadata, missing endpoints); suppressing PLR0911 preserves the
    shape.
    """
    try:
        info = json.loads(data)
    except json.JSONDecodeError:
        log.debug("ignoring non-JSON $SRV.INFO response (%d bytes)", len(data))
        return None
    if not isinstance(info, dict):
        return None
    if info.get("name") not in _ACCEPTED_SERVICE_NAMES:
        return None
    metadata = info.get("metadata") or {}
    if not isinstance(metadata, dict):
        return None
    agent_id = metadata.get("agent")
    if not agent_id:
        log.warning("Synadia Agents service lacks metadata.agent: %r", info)
        return None

    prompt_endpoint = _extract_prompt_endpoint(info.get("endpoints"))
    if prompt_endpoint is None:
        log.warning("Synadia Agents service lacks a `prompt` endpoint: %r", info)
        return None

    # §4.3: derive the instance name from the 4th token of the prompt endpoint's
    # subject when the subject follows the default `agents.{agent}.{owner}.{name}`
    # layout. For custom subjects, the instance name is harness-specific and
    # opaque to the caller (left empty here).
    parts = prompt_endpoint.subject.split(".")
    instance_name = (
        parts[3] if len(parts) == _DEFAULT_INBOX_TOKEN_COUNT and parts[0] == "agents" else ""
    )

    session_raw = metadata.get("session")
    session = session_raw if isinstance(session_raw, str) and session_raw else None

    return DiscoveredAgent(
        name=instance_name,
        agent=agent_id,
        owner=metadata.get("owner", ""),
        inbox=prompt_endpoint.subject,
        service_id=info.get("id", ""),
        description=info.get("description", ""),
        prompt_endpoint=prompt_endpoint,
        session=session,
    )


def _extract_prompt_endpoint(endpoints: object) -> EndpointInfo | None:
    """Pick the ``prompt`` endpoint from an $SRV.INFO ``endpoints`` array.

    §2.1 declares ``max_payload`` as a size string (e.g. ``"1MB"``) and
    ``attachments_ok`` as a boolean; because endpoint metadata on the wire
    is ``Record<string, string>``, the boolean travels as ``"true"`` /
    ``"false"``. Unparseable values leave the parsed fields ``None`` — the
    raw string is preserved under ``metadata`` (§5.6).
    """
    if not isinstance(endpoints, list):
        return None
    for ep in endpoints:
        if not isinstance(ep, dict) or ep.get("name") != "prompt":
            continue
        subject = ep.get("subject")
        if not isinstance(subject, str) or not subject:
            return None
        raw_md = ep.get("metadata") or {}
        metadata: Mapping[str, str] = (
            MappingProxyType({str(k): str(v) for k, v in raw_md.items()})
            if isinstance(raw_md, dict)
            else MappingProxyType({})
        )
        max_payload_bytes: int | None = None
        mp = metadata.get("max_payload")
        if mp is not None:
            try:
                max_payload_bytes = parse_human_bytes(mp)
            except InvalidSizeError:
                max_payload_bytes = None  # raw remains in metadata per §5.6
        attachments_ok: bool | None
        ao = metadata.get("attachments_ok")
        if ao == "true":
            attachments_ok = True
        elif ao == "false":
            attachments_ok = False
        else:
            attachments_ok = None
        return EndpointInfo(
            name="prompt",
            subject=subject,
            metadata=metadata,
            max_payload_bytes=max_payload_bytes,
            attachments_ok=attachments_ok,
        )
    return None
