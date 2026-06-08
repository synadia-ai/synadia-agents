# 03 · LLM agent (OpenRouter) — forward each prompt to OpenRouter, stream the reply.
#
# Same shape as 02-ollama, but the backend is the hosted, OpenAI-compatible
# OpenRouter API instead of a local Ollama. Requires an API key; no GPU needed.
# Python mirror of agent-sdk/typescript/examples/03-openrouter.ts.
#
# Prerequisites: an OpenRouter API key (https://openrouter.ai/keys):
#   export OPENROUTER_API_KEY=sk-or-...
# Backend config via env: OPENROUTER_API_KEY (required), OPENROUTER_MODEL
# (default openai/gpt-4o-mini).
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

API_KEY = os.environ.get("OPENROUTER_API_KEY")
MODEL = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"


async def openrouter_tokens(prompt: str) -> AsyncGenerator[str, None]:
    # OpenAI SSE: `data: {json}` lines (+ keep-alive comments), then `data: [DONE]`.
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    async with (
        httpx.AsyncClient(timeout=None) as client,
        client.stream(
            "POST",
            ENDPOINT,
            headers=headers,
            json={
                "model": MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "stream": True,
            },
        ) as resp,
    ):
        resp.raise_for_status()
        async for raw in resp.aiter_lines():
            line = raw.strip()
            if not line.startswith("data:"):
                continue
            data = line[len("data:") :].strip()
            if data in ("", "[DONE]"):
                continue
            try:
                token = json.loads(data)["choices"][0]["delta"].get("content")
            except (json.JSONDecodeError, KeyError, IndexError):
                continue
            if token:
                yield token


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="LLM agent — streams replies from a hosted OpenRouter model."
    )
    add_connection_flags(parser)
    add_agent_identity_flags(parser)
    args = parser.parse_args()

    # Checked after parse_args so `--help` works without a key.
    if not API_KEY:
        print(
            "OPENROUTER_API_KEY is not set — get one at https://openrouter.ai/keys",
            file=sys.stderr,
        )
        sys.exit(1)

    nc = await connect_from_cli(args)

    service = AgentService(
        agent="openrouter",
        owner=args.owner,
        session_name=args.session_name,
        nc=nc,
        description=f"LLM agent — answers prompts with OpenRouter '{MODEL}'",
        heartbeat_interval_s=args.heartbeat_interval,
    )

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        async for token in openrouter_tokens(envelope.prompt):
            await stream.send(token)

    service.on_prompt(handler)
    await service.start()
    print(f"openrouter agent listening on {service.subject.prompt}")
    print(f"prompting model '{MODEL}' via OpenRouter")
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
