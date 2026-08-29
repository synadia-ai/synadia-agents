"""Reverse lookup: from an agent ID to the agent that registered it (spec "Reverse lookup").

1. Enumerate instances through ``$SRV.INFO.agents`` and index them by
   ``(account, user_nkey)``.
2. Verify ``id_sig`` on each candidate against its own ``prompt``
   endpoint subject; drop failures (``build_agent_info`` already runs
   that verification per record — :attr:`AgentInfo.id_sig_verified`).
3. Return the instance's :class:`AgentInfo`, or ``None`` when no verified
   instance claims the key: the sender is then not a reachable agent.

Enumeration is scatter-gather over every instance, so
:class:`SenderResolver` caches the index for a short TTL (default 10 s)
instead of enumerating per message. Discovery is account-local: a lookup
only sees agents whose ``$SRV`` subjects the connection's account can
reach. The lookup **identifies**; it never authorizes.
"""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING

from .agent_id import AgentId

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from ..discovery import AgentInfo

#: Default TTL of the ``$SRV.INFO`` index (spec: suggested, not required).
DEFAULT_RESOLVE_TTL_S = 10.0


class SenderResolver:
    """A TTL-cached ``$SRV.INFO.agents`` index keyed by verified agent ID."""

    def __init__(
        self,
        nc: NATSClient,
        *,
        ttl_s: float = DEFAULT_RESOLVE_TTL_S,
        timeout_s: float | None = None,
        stall_s: float | None = None,
        max_wait_s: float | None = None,
    ) -> None:
        """``timeout_s`` / ``stall_s`` / ``max_wait_s`` are :meth:`Agents.discover`'s knobs."""
        if ttl_s < 0:
            raise ValueError(f"ttl_s must be >= 0 (got {ttl_s!r})")
        self._nc = nc
        self._ttl_s = ttl_s
        self._timeout_s = timeout_s
        self._stall_s = stall_s
        self._max_wait_s = max_wait_s
        self._index: dict[AgentId, tuple[AgentInfo, ...]] = {}
        self._built_at: float | None = None
        self._refresh: asyncio.Task[None] | None = None

    @property
    def ttl_s(self) -> float:
        return self._ttl_s

    def invalidate(self) -> None:
        """Drop the cached index; the next :meth:`resolve` enumerates again."""
        self._index = {}
        self._built_at = None

    async def resolve(self, id: AgentId | str) -> AgentInfo | None:
        """The verified instance registered under ``id``, or ``None``.

        Several instances of one logical agent share one user and therefore
        one agent ID; the first one the index holds is returned.
        """
        key = AgentId.parse(id)
        if self._built_at is None or time.monotonic() - self._built_at >= self._ttl_s:
            await self._rebuild()
        matches = self._index.get(key)
        return matches[0] if matches else None

    async def _rebuild(self) -> None:
        if self._refresh is None:
            self._refresh = asyncio.create_task(self._enumerate(), name="agents-resolve-sender")
        try:
            await asyncio.shield(self._refresh)
        finally:
            if self._refresh is not None and self._refresh.done():
                self._refresh = None

    async def _enumerate(self) -> None:
        # Imported here: `discovery` imports the identity codec at module
        # level (id_sig verification in `build_agent_info`), so a top-level
        # import would be circular.
        from ..discovery import (  # noqa: PLC0415
            DEFAULT_DISCOVER_MAX_WAIT_S,
            DEFAULT_DISCOVER_STALL_S,
            discover_agent_infos,
        )

        infos = await discover_agent_infos(
            self._nc,
            timeout_s=self._timeout_s,
            stall_s=self._stall_s if self._stall_s is not None else DEFAULT_DISCOVER_STALL_S,
            max_wait_s=(
                self._max_wait_s if self._max_wait_s is not None else DEFAULT_DISCOVER_MAX_WAIT_S
            ),
        )
        index: dict[AgentId, list[AgentInfo]] = {}
        for info in infos:
            if info.identity is not None and info.id_sig_verified:
                index.setdefault(info.identity, []).append(info)
        self._index = {k: tuple(v) for k, v in index.items()}
        self._built_at = time.monotonic()


async def resolve_sender(
    nc: NATSClient, id: AgentId | str, *, timeout_s: float | None = None
) -> AgentInfo | None:
    """One uncached reverse lookup (see :class:`SenderResolver` for the cached form)."""
    return await SenderResolver(nc, ttl_s=0.0, timeout_s=timeout_s).resolve(id)


__all__ = ["DEFAULT_RESOLVE_TTL_S", "SenderResolver", "resolve_sender"]
