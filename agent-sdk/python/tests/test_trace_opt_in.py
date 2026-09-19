"""Tracing must be entirely opt-in.

With nothing configured for tracing, an agent must behave exactly as it
did before the extension existed: no ids minted per request, no ambient
scope bound, and — the one with teeth — no trace headers handed to the
harness, which would stamp them on model requests going to a third party
the operator never opted into.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import nats
from synadia_ai.agents import Agents, TraceOptions, active_trace

from synadia_ai.agent_service import AgentService

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.nats_server import RunningServer


async def _run(
    nc: NATSClient,
    agent: str,
    *,
    service_trace: TraceOptions | None,
    client_trace: TraceOptions | None,
) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    svc = AgentService(
        nc=nc,
        agent=agent,
        owner="p",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        trace=service_trace,
    )

    async def handler(env: Any, stream: Any) -> None:
        seen["headers"] = stream.trace_headers()
        seen["scope"] = active_trace()
        await stream.send("ok")

    svc.on_prompt(handler)
    await svc.start()

    client = Agents(nc=nc, trace=client_trace)
    handle = next(a for a in await client.discover() if a.agent == agent)
    async for _ in handle.prompt("hi"):
        pass
    await asyncio.sleep(0.1)
    await svc.stop()
    await client.close()
    return seen


async def test_untraced_agent_hands_out_no_trace_headers(nats_server: RunningServer) -> None:
    nc = await nats.connect(nats_server.url)
    seen = await _run(nc, "optout", service_trace=None, client_trace=None)
    assert seen["headers"] == {}
    assert seen["scope"] is None, "an untraced service still bound an ambient scope"
    await nc.close()


async def test_service_that_opted_in_gets_headers(nats_server: RunningServer) -> None:
    nc = await nats.connect(nats_server.url)
    seen = await _run(nc, "optin", service_trace=TraceOptions(), client_trace=None)
    assert set(seen["headers"]) == {"X-Synadia-Thread-ID", "X-Synadia-Root-ID"}
    await nc.close()


async def test_lineage_from_the_caller_is_adopted_by_an_untraced_service(
    nats_server: RunningServer,
) -> None:
    """A tree that starts upstream must not be broken by a service that
    did not itself opt in."""
    nc = await nats.connect(nats_server.url)
    seen = await _run(nc, "relay", service_trace=None, client_trace=TraceOptions())
    assert seen["scope"] is not None
    assert set(seen["headers"]) == {"X-Synadia-Thread-ID", "X-Synadia-Root-ID"}
    await nc.close()
