# 02 · LLM agent (Ollama) — forward each prompt to a local Ollama, stream the reply.
#
# Step 2 of the ladder: take 01-echo and swap the one-line `echo:` reply for a
# real LLM round-trip. The agent shape is identical — only the handler body
# changes. Python mirror of agent-sdk/typescript/examples/02-ollama.ts.
#
# Prerequisites: a local Ollama (https://ollama.com) with a model pulled:
#   ollama pull llama3.2
# Backend config via env: OLLAMA_URL (default http://localhost:11434),
# OLLAMA_MODEL (default llama3.2).
#
# Identity/heartbeat via --owner/--session-name/--heartbeat-interval or the
# matching NATS_AGENT_* env vars. Connection: --context/--url, else
# $NATS_CONTEXT/$NATS_URL, else the selected `nats` context. Run -h for flags.

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
from collections.abc import AsyncGenerator
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from synadia_ai.agents import Envelope

from examples._connect_cli import (
    add_agent_identity_flags,
    add_connection_flags,
    connect_from_cli,
)
from synadia_ai.agent_service import AgentService, PromptStream

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2")


async def ollama_tokens(prompt: str) -> AsyncGenerator[str, None]:
    # Ollama's /api/generate returns newline-delimited JSON — one object per line,
    # each carrying the next `response` fragment. httpx.aiter_lines() hands us
    # those lines as they arrive, so tokens flow out as the model produces them.
    async with (
        httpx.AsyncClient(timeout=None) as client,
        client.stream(
            "POST",
            f"{OLLAMA_URL}/api/generate",
            json={"model": MODEL, "prompt": prompt, "stream": True},
        ) as resp,
    ):
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.strip():
                continue
            # A rare malformed line shouldn't crash the stream — skip it.
            try:
                token = json.loads(line).get("response", "")
            except json.JSONDecodeError:
                continue
            if token:
                yield token


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="LLM agent — streams replies from a local Ollama model."
    )
    add_connection_flags(parser)
    add_agent_identity_flags(parser)
    args = parser.parse_args()

    nc = await connect_from_cli(args)

    service = AgentService(
        agent="ollama",
        owner=args.owner,
        session_name=args.session_name,
        nc=nc,
        description=f"LLM agent — answers prompts with the local Ollama '{MODEL}' model",
        heartbeat_interval_s=args.heartbeat_interval,
    )

    # Same handler shape as the echo agent: instead of one reply, we send each
    # token as Ollama emits it.
    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        async for token in ollama_tokens(envelope.prompt):
            await stream.send(token)

    service.on_prompt(handler)
    await service.start()
    print(f"ollama agent listening on {service.subject.prompt}")
    print(f"prompting model '{MODEL}' at {OLLAMA_URL}")
    print("press Ctrl+C to stop")

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for _sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(_sig, stop.set)
    try:
        await stop.wait()
    finally:
        print("\nshutting down…")
        await service.stop()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
