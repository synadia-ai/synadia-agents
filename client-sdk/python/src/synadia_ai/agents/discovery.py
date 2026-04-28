"""Discovery primitives — service constants, endpoint/agent records, ``$SRV.INFO`` plumbing.

Mirrors the TS SDK's ``discovery/`` subtree (PR #7) field-for-field:

- :class:`AgentInfo` — pure data record assembled from a ``$SRV.INFO`` reply
  per spec §4.3. The :class:`~synadia_ai.agents.agent.Agent` class wraps this with
  the :class:`~nats.aio.client.Client` needed to prompt it.
- :class:`EndpointInfo` — parsed endpoint record (§2.1, §4.3); ``max_payload``
  / ``attachments_ok`` parsed for the ``prompt`` endpoint, raw strings always
  preserved in ``metadata`` for §5.6 forward-compat.
- :func:`build_agent_info` — convert a parsed ``$SRV.INFO`` dict into an
  :class:`AgentInfo`, returning ``None`` when the record is not protocol-
  compliant. Pure function; callable from tests / harnesses without a NATS
  connection.
- :func:`request_many_stall` — discovery's "wait until quiet" request fan-out:
  subscribe to a fresh inbox, publish, return responses after a stall window
  or absolute max-wait, whichever fires first.
- :func:`ping_instance` — on-demand reachability via
  ``$SRV.PING.agents.{instance_id}`` (spec §8.4).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING

from nats.errors import NoRespondersError

from ._bytes import InvalidSizeError, parse_human_bytes
from ._inbox import new_inbox as _new_inbox
from ._logging import get_logger

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

log = get_logger(__name__)


# --- service-name constants ---------------------------------------------

# §3.1: every compliant agent registers under the shared service name `agents`.
SERVICE_NAME = "agents"

# §3.3: the `prompt` endpoint MUST register queue group `"agents"` so multiple
# instances of the same logical agent load-balance.
PROMPT_QUEUE_GROUP = "agents"

# §2.1 / §12: the endpoint name reserved for the prompt entry point.
PROMPT_ENDPOINT_NAME = "prompt"

# v0.3 §-TBD: the request/response endpoint that returns a fresh heartbeat-
# shaped payload. Same queue group as `prompt` — instances of the same
# logical agent share `agents.status.{a}.{o}.{n}`, so callers load-balance to
# one responder.
STATUS_ENDPOINT_NAME = "status"
STATUS_QUEUE_GROUP = "agents"


# --- discovery defaults --------------------------------------------------

# Idle window after the most recent reply before discover() returns
# (stall strategy). Mirrors TS DEFAULT_DISCOVER_STALL_MS.
DEFAULT_DISCOVER_STALL_S: float = 0.2

# Absolute safety cap when using the stall strategy. Mirrors TS
# DEFAULT_DISCOVER_MAX_WAIT_MS.
DEFAULT_DISCOVER_MAX_WAIT_S: float = 2.0


# --- subject-name shapes -------------------------------------------------

# `agents.prompt.{agent}.{owner}.{session_name}` — 5 dot tokens (§2 v0.3).
# Custom prompt-endpoint subjects break this pattern, in which case the
# session name is opaque to the caller (§4.3).
_DEFAULT_PROMPT_TOKEN_COUNT = 5


# --- typed records -------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EndpointInfo:
    """Parsed endpoint record from ``$SRV.INFO`` (§2.1, §4.3).

    ``max_payload_bytes`` and ``attachments_ok`` are populated only when the
    ``prompt`` endpoint declared them (the protocol requires both per §2.1).
    Unparseable ``max_payload`` strings leave the field ``None``; the raw
    string remains in ``metadata`` per §5.6.
    """

    name: str
    subject: str
    queue_group: str = ""
    metadata: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    max_payload_bytes: int | None = None
    attachments_ok: bool | None = None


@dataclass(frozen=True, slots=True)
class AgentInfo:
    """Pure-data view of an agent assembled from a ``$SRV.INFO`` reply (§4.3).

    The :class:`~synadia_ai.agents.agent.Agent` class wraps this with the
    :class:`~nats.aio.client.Client` needed to prompt it. ``instance_id`` is
    the NATS micro service id; matches ``heartbeat.instance_id`` (§8.3) and
    is the addressing key for ``$SRV.INFO.agents.{id}`` direct lookup (§4.2).
    ``session_name`` is the 5th token of the prompt subject (v0.3) — the
    session this agent serves.
    """

    instance_id: str
    agent: str
    owner: str
    session_name: str
    protocol_version: str
    description: str
    version: str
    metadata: Mapping[str, str]
    endpoints: tuple[EndpointInfo, ...]
    prompt_endpoint: EndpointInfo


# --- $SRV.INFO parsing ---------------------------------------------------


def build_agent_info(info: dict[str, object]) -> AgentInfo | None:  # noqa: PLR0911
    """Convert a parsed ``$SRV.INFO`` reply into an :class:`AgentInfo`.

    Returns ``None`` when the record is not a protocol-compliant agent —
    callers silently drop these so unrelated micro-services sharing the
    NATS account don't pollute discovery results. Specifically, returns
    ``None`` when:

    - The service ``name`` is not ``"agents"`` (§3.1).
    - Any of ``metadata.agent``, ``metadata.owner``, ``metadata.protocol_version``
      is missing or non-string (§3.2).
    - No endpoint named ``prompt`` is declared (§2.1, §12).
    """
    if not isinstance(info, dict):
        return None
    if info.get("name") != SERVICE_NAME:
        return None

    raw_metadata = info.get("metadata") or {}
    if not isinstance(raw_metadata, dict):
        return None
    metadata: Mapping[str, str] = MappingProxyType(
        {str(k): str(v) for k, v in raw_metadata.items()}
    )

    agent_id = metadata.get("agent")
    owner = metadata.get("owner")
    protocol_version = metadata.get("protocol_version")
    if not agent_id or not owner or not protocol_version:
        log.warning("agents service missing required metadata fields: %r", info)
        return None

    raw_endpoints = info.get("endpoints")
    if not isinstance(raw_endpoints, list):
        log.warning("agents service has no endpoints array: %r", info)
        return None

    endpoints = tuple(_build_endpoint_info(ep) for ep in raw_endpoints if isinstance(ep, dict))
    prompt_endpoint = next((e for e in endpoints if e.name == PROMPT_ENDPOINT_NAME), None)
    if prompt_endpoint is None:
        log.warning("agents service lacks a `prompt` endpoint: %r", info)
        return None

    # §4.3: derive the session name from the 5th token of the prompt endpoint's
    # subject when it follows the default
    # `agents.prompt.{agent}.{owner}.{session_name}` layout (v0.3). Custom
    # subjects leave the session name opaque to the caller (empty string).
    parts = prompt_endpoint.subject.split(".")
    session_name = (
        parts[4]
        if len(parts) == _DEFAULT_PROMPT_TOKEN_COUNT
        and parts[0] == "agents"
        and parts[1] == "prompt"
        else ""
    )

    raw_id = info.get("id")
    instance_id = raw_id if isinstance(raw_id, str) else ""
    raw_description = info.get("description")
    description = raw_description if isinstance(raw_description, str) else ""
    raw_version = info.get("version")
    version = raw_version if isinstance(raw_version, str) else ""

    return AgentInfo(
        instance_id=instance_id,
        agent=str(agent_id),
        owner=str(owner),
        session_name=session_name,
        protocol_version=str(protocol_version),
        description=description,
        version=version,
        metadata=metadata,
        endpoints=endpoints,
        prompt_endpoint=prompt_endpoint,
    )


def _build_endpoint_info(raw: Mapping[str, object]) -> EndpointInfo:
    """Convert one ``$SRV.INFO.endpoints[]`` entry into :class:`EndpointInfo`."""
    name = str(raw.get("name", ""))
    subject = str(raw.get("subject", ""))
    queue_group = str(raw.get("queue_group", "") or "")
    raw_md = raw.get("metadata") or {}
    metadata: Mapping[str, str] = (
        MappingProxyType({str(k): str(v) for k, v in raw_md.items()})
        if isinstance(raw_md, dict)
        else MappingProxyType({})
    )

    if name != PROMPT_ENDPOINT_NAME:
        return EndpointInfo(
            name=name,
            subject=subject,
            queue_group=queue_group,
            metadata=metadata,
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
        name=name,
        subject=subject,
        queue_group=queue_group,
        metadata=metadata,
        max_payload_bytes=max_payload_bytes,
        attachments_ok=attachments_ok,
    )


# --- discover() request-many ---------------------------------------------


@dataclass(frozen=True, slots=True)
class DiscoverFilter:
    """AND-matched identity filter for :meth:`Agents.discover`.

    Each non-``None`` field is compared verbatim against the corresponding
    :class:`AgentInfo` field; missing fields match anything. Mirrors the
    TS SDK's ``DiscoveryFilter`` interface.
    """

    agent: str | None = None
    owner: str | None = None
    session_name: str | None = None
    protocol_version: str | None = None


def matches_filter(info: AgentInfo, filt: DiscoverFilter | None) -> bool:
    """True iff every set field on ``filt`` matches ``info`` verbatim."""
    if filt is None:
        return True
    checks = (
        (filt.agent, info.agent),
        (filt.owner, info.owner),
        (filt.session_name, info.session_name),
        (filt.protocol_version, info.protocol_version),
    )
    return all(want is None or got == want for want, got in checks)


async def request_many_stall(
    nc: NATSClient,
    subject: str,
    *,
    payload: bytes = b"",
    timeout_s: float | None = None,
    stall_s: float = DEFAULT_DISCOVER_STALL_S,
    max_wait_s: float = DEFAULT_DISCOVER_MAX_WAIT_S,
) -> list[bytes]:
    """Fan-out request: collect every reply into a list, then return.

    Two strategies, mirroring nats-py's request-many semantics:

    - **timer** (``timeout_s`` set): wait exactly ``timeout_s``, return
      every reply seen in that window. Use for deterministic scans.
    - **stall** (``timeout_s`` unset): return ``stall_s`` after the most
      recent reply, or after ``max_wait_s`` absolute, whichever comes
      first. Use for snappy interactive paths.

    Subscribes to a fresh inbox before publishing so no replies are
    missed between PUB and SUB. Returns the raw response bytes; the
    caller is responsible for parsing.

    Raises :class:`~nats.errors.NoRespondersError` is intentionally NOT
    raised here — discover() treats "no responders" as "empty result"
    and translates it before this function returns.
    """
    inbox = _new_inbox()
    sub = await nc.subscribe(inbox)
    responses: list[bytes] = []
    loop = asyncio.get_running_loop()
    try:
        await nc.publish(subject, payload, reply=inbox)
        if timeout_s is not None:
            # Timer strategy: drain replies until the absolute deadline.
            deadline = loop.time() + timeout_s
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                try:
                    msg = await sub.next_msg(timeout=remaining)
                except TimeoutError:
                    break
                responses.append(msg.data)
        else:
            # Stall strategy: stop once we see no reply for `stall_s`, but
            # never wait longer than `max_wait_s` total.
            absolute_deadline = loop.time() + max_wait_s
            while True:
                stall_deadline = loop.time() + stall_s
                # Wait for the earlier of (stall window after last reply)
                # and (absolute safety cap).
                next_wait = min(stall_deadline, absolute_deadline) - loop.time()
                if next_wait <= 0:
                    break
                try:
                    msg = await sub.next_msg(timeout=next_wait)
                except TimeoutError:
                    break
                responses.append(msg.data)
                if loop.time() >= absolute_deadline:
                    break
    finally:
        with contextlib.suppress(Exception):
            await sub.unsubscribe()
    return responses


async def ping_instance(
    nc: NATSClient,
    instance_id: str,
    *,
    timeout: float = 2.0,
) -> bool:
    """On-demand reachability check for a single instance (§8.4).

    Returns ``True`` as soon as a reply arrives within ``timeout``;
    ``False`` on timeout or :class:`~nats.errors.NoRespondersError` (the
    instance id is not registered). Subjects per §8.4:
    ``$SRV.PING.agents.{instance_id}``.
    """
    subject = f"$SRV.PING.{SERVICE_NAME}.{instance_id}"
    try:
        await nc.request(subject, b"", timeout=timeout)
    except TimeoutError:
        log.debug("ping(%s): no reply within %.1fs", instance_id, timeout)
        return False
    except NoRespondersError:
        log.debug("ping(%s): broker reports no responders", instance_id)
        return False
    return True


async def discover_agent_infos(
    nc: NATSClient,
    *,
    timeout_s: float | None = None,
    stall_s: float = DEFAULT_DISCOVER_STALL_S,
    max_wait_s: float = DEFAULT_DISCOVER_MAX_WAIT_S,
) -> list[AgentInfo]:
    """Discover and parse every protocol-compliant agent on the bus.

    Pure §4 enumeration: publishes ``$SRV.INFO.agents``, drains replies
    via :func:`request_many_stall`, parses each through
    :func:`build_agent_info`. Filtering by identity is the caller's job
    (use :func:`matches_filter` after).
    """
    try:
        responses = await request_many_stall(
            nc,
            f"$SRV.INFO.{SERVICE_NAME}",
            timeout_s=timeout_s,
            stall_s=stall_s,
            max_wait_s=max_wait_s,
        )
    except NoRespondersError:
        return []

    out: list[AgentInfo] = []
    for data in responses:
        try:
            parsed = json.loads(data)
        except json.JSONDecodeError:
            log.debug("ignoring non-JSON $SRV.INFO response (%d bytes)", len(data))
            continue
        info = build_agent_info(parsed) if isinstance(parsed, dict) else None
        if info is not None:
            out.append(info)
    log.debug("discover() parsed %d agent info record(s)", len(out))
    return out


__all__ = [
    "DEFAULT_DISCOVER_MAX_WAIT_S",
    "DEFAULT_DISCOVER_STALL_S",
    "PROMPT_ENDPOINT_NAME",
    "PROMPT_QUEUE_GROUP",
    "SERVICE_NAME",
    "STATUS_ENDPOINT_NAME",
    "STATUS_QUEUE_GROUP",
    "AgentInfo",
    "DiscoverFilter",
    "EndpointInfo",
    "build_agent_info",
    "discover_agent_infos",
    "matches_filter",
    "ping_instance",
    "request_many_stall",
]
