"""One execution's trace must stay its own.

The ambient scope is bound per request and must not survive it, be shared
with a concurrent request, or carry its turn count into the next one.
Work spawned inside a handler is the deliberate exception: a tool running
as its own task belongs to the same execution and counts against it.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import nats
from synadia_ai.agents import Agents, TraceOptions, active_trace

from synadia_ai.agent_service import AgentService

if TYPE_CHECKING:
    from tests.harness.nats_server import RunningServer


async def test_scope_does_not_leak_between_requests(nats_server: RunningServer) -> None:
    nc = await nats.connect(nats_server.url)
    seen: list[Any] = []

    svc = AgentService(
        nc=nc,
        agent="iso",
        owner="p",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        trace=TraceOptions(),
    )

    async def handler(env: Any, stream: Any) -> None:
        scope = active_trace()
        assert scope is not None
        seen.append(scope.thread_id)
        await asyncio.sleep(0.02)  # yield mid-handler
        after = active_trace()
        assert after is not None and after.thread_id == scope.thread_id, "scope changed mid-handler"
        await stream.send("ok")

    svc.on_prompt(handler)
    await svc.start()

    client = Agents(nc=nc)
    handle = next(a for a in await client.discover() if a.agent == "iso")
    for _ in range(3):
        async for _m in handle.prompt("hi"):
            pass
    await asyncio.sleep(0.1)

    assert len(seen) == 3, seen
    assert len(set(seen)) == 3, f"threads repeated across requests: {seen}"
    assert active_trace() is None, "scope leaked outside the handler"
    await svc.stop()
    await client.close()
    await nc.close()


async def test_turn_counter_is_per_request(nats_server: RunningServer) -> None:
    nc = await nats.connect(nats_server.url)
    counts: list[int] = []

    svc = AgentService(
        nc=nc,
        agent="iso2",
        owner="p",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        trace=TraceOptions(),
    )

    async def handler(env: Any, stream: Any) -> None:
        stream.trace_headers()
        stream.trace_headers()
        scope = active_trace()
        assert scope is not None
        counts.append(scope.turn_count_hint[0])
        await stream.send("ok")

    svc.on_prompt(handler)
    await svc.start()
    client = Agents(nc=nc)
    handle = next(a for a in await client.discover() if a.agent == "iso2")
    for _ in range(3):
        async for _m in handle.prompt("hi"):
            pass
    await asyncio.sleep(0.1)
    assert counts == [2, 2, 2], f"turn counter carried across requests: {counts}"
    await svc.stop()
    await client.close()
    await nc.close()


async def test_concurrent_requests_do_not_share_a_scope(nats_server: RunningServer) -> None:
    nc = await nats.connect(nats_server.url)
    pairs: list[tuple[str, str]] = []

    svc = AgentService(
        nc=nc,
        agent="conc",
        owner="p",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        trace=TraceOptions(),
    )

    async def handler(env: Any, stream: Any) -> None:
        before = active_trace().thread_id  # type: ignore[union-attr]
        await asyncio.sleep(0.15)  # overlap with the other request
        after = active_trace().thread_id  # type: ignore[union-attr]
        pairs.append((before, after))
        await stream.send("ok")

    svc.on_prompt(handler)
    await svc.start()
    client = Agents(nc=nc)
    handle = next(a for a in await client.discover() if a.agent == "conc")

    async def once() -> None:
        async for _m in handle.prompt("hi"):
            pass

    await asyncio.gather(once(), once(), once())
    await asyncio.sleep(0.1)
    assert len(pairs) == 3, pairs
    for before, after in pairs:
        assert before == after, f"scope changed under a concurrent request: {before} -> {after}"
    assert len({p[0] for p in pairs}) == 3, f"threads shared across concurrent requests: {pairs}"
    await svc.stop()
    await client.close()
    await nc.close()


async def test_task_spawned_inside_the_handler_shares_the_scope(nats_server: RunningServer) -> None:
    nc = await nats.connect(nats_server.url)
    seen: dict[str, Any] = {}

    svc = AgentService(
        nc=nc,
        agent="spawn",
        owner="p",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        trace=TraceOptions(),
    )

    async def handler(env: Any, stream: Any) -> None:
        stream.trace_headers()

        async def tool() -> None:
            # A tool running as its own task must count against the same
            # execution and see the same thread.
            seen["headers"] = stream.trace_headers()
            seen["thread"] = active_trace().thread_id  # type: ignore[union-attr]

        task = asyncio.create_task(tool())
        await task
        seen["count"] = active_trace().turn_count_hint[0]  # type: ignore[union-attr]
        seen["outer_thread"] = active_trace().thread_id  # type: ignore[union-attr]
        await stream.send("ok")

    svc.on_prompt(handler)
    await svc.start()
    client = Agents(nc=nc)
    handle = next(a for a in await client.discover() if a.agent == "spawn")
    async for _m in handle.prompt("hi"):
        pass
    await asyncio.sleep(0.1)
    assert seen["thread"] == seen["outer_thread"], seen
    assert seen["count"] == 2, f"spawned task did not count against the execution: {seen}"
    await svc.stop()
    await client.close()
    await nc.close()
