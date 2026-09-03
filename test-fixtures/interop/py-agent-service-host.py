"""A minimal ``AgentService`` host for cross-language and cross-version tracing
interop tests.

Run with the interpreter of the packages under test: the agent-sdk project
environment for the in-repo packages, or a scratch venv holding the last
published (pre-tracing) release — the script uses only API that exists in
both, and probes for ``trace_headers()`` at runtime.

Environment:
    NATS_URL             server to connect to (required)
    AGENT                ``agent`` token (default ``interop-host``)
    TRACE=1              opt the service into tracing (unknown to a host
                         that predates it, so it is simply not passed)
    NATS_NKEY_SEED_FILE  authenticate the connection with this user seed

Echo: ``echo: <prompt>`` plus `` thread=<id> root=<id>`` when the execution
was traced, so a caller can see what the host adopted or minted.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import signal
from pathlib import Path
from typing import Any

import nats
from synadia_ai.agent_service import AgentService


async def main() -> None:
    url = os.environ["NATS_URL"]
    agent = os.environ.get("AGENT", "interop-host")
    seed_file = os.environ.get("NATS_NKEY_SEED_FILE")
    connect_kwargs: dict[str, Any] = {}
    if seed_file:
        connect_kwargs["nkeys_seed_str"] = Path(seed_file).read_text(encoding="utf-8").strip()
    nc = await nats.connect(url, allow_reconnect=False, **connect_kwargs)

    kwargs: dict[str, Any] = {}
    accepts_trace = "trace" in inspect.signature(AgentService.__init__).parameters
    if os.environ.get("TRACE") == "1" and accepts_trace:
        from synadia_ai.agents import TraceOptions

        kwargs["trace"] = TraceOptions()

    svc = AgentService(
        nc=nc,
        agent=agent,
        owner="interop",
        session_name="host",
        heartbeat_interval_s=5,
        keepalive_interval_s=None,
        **kwargs,
    )

    async def handler(envelope: Any, stream: Any) -> None:
        # `trace_headers()` does not exist on a pre-tracing host.
        headers = stream.trace_headers() if hasattr(stream, "trace_headers") else {}
        text = f"echo: {envelope.prompt}"
        thread = headers.get("X-Synadia-Thread-ID")
        if thread is not None:
            text += f" thread={thread} root={headers.get('X-Synadia-Root-ID', '')}"
        await stream.send(text)

    svc.on_prompt(handler)
    await svc.start()
    subject = getattr(svc, "subject", None)
    prompt_subject = subject.prompt if subject is not None else f"agents.prompt.{agent}.interop.host"
    print(f"agent service listening on {prompt_subject}", flush=True)

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        try:
            await svc.stop()
        finally:
            await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
