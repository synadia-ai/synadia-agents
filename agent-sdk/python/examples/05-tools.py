# 05 · LLM agent with a tool backed by a NATS microservice (Python).
#
# The top of the ladder. Examples 2-4 gave the agent a model; this gives it a
# *tool*, and wires that tool to a NATS microservice. Python mirror of
# agent-sdk/typescript/examples/05-tools.ts. The point of the demo:
#
#   any microservice already on your NATS network can become an agent
#   capability — the agent need not embed the database, device, or credential
#   that sits behind it.
#
# The agent here holds only an LLM and a NATS connection; it can't read a sensor
# itself. When the model needs live data it calls the tool, the tool makes a
# single nc.request(...), and a microservice answers. For a self-contained demo
# the service is faked in this same file; in production it runs elsewhere.
#
# Two round-trips with Ollama (/api/chat with tools): first the model asks to
# call read_sensor(location); then — once we feed the reading back — it streams
# its final answer. Needs a tool-capable model (default llama3.1:8b).
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
from typing import TYPE_CHECKING, Any

import httpx
from nats.micro import ServiceConfig, add_service
from nats.micro.service import EndpointConfig

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from synadia_ai.agents import Envelope

from examples._connect_cli import (
    add_agent_identity_flags,
    add_connection_flags,
    connect_from_cli,
)
from synadia_ai.agent_service import AgentService, PromptStream

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.micro.service import Request

MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

# Subject the sensor microservice listens on. The agent's tool sends requests
# here; nothing else couples the agent to the service.
SENSOR_SUBJECT = "sensors.read"

# The microservice's data — a stand-in for "some service already on your
# network". Room 3 is deliberately too warm, so the agent has something to flag.
READINGS: dict[str, float] = {
    "cold-storage-1": 3.4,
    "cold-storage-2": 2.8,
    "cold-storage-3": 6.2,
}

# What we advertise to the model. The handler body is the whole point: one NATS
# request to the microservice (see run_tool).
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_sensor",
            "description": "Read the current temperature in Celsius at a location.",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "sensor location, e.g. 'cold-storage-3'",
                    },
                },
                "required": ["location"],
            },
        },
    },
]


async def start_sensor_service(nc: NATSClient) -> None:
    """Register a NATS micro service that answers SENSOR_SUBJECT with a reading.

    In production this is a separate process somewhere on the network — here it
    just shares the agent's connection so the demo is self-contained.
    """
    service = await add_service(
        nc,
        ServiceConfig(
            name="sensors",
            version="0.1.0",
            description="Returns the current temperature (°C) for a location",
        ),
    )

    async def handler(req: Request) -> None:
        location = req.data.decode()  # request body is the bare location
        reading = READINGS.get(location)
        await req.respond(b"unknown" if reading is None else str(reading).encode())

    await service.add_endpoint(
        EndpointConfig(name="read", subject=SENSOR_SUBJECT, handler=handler),
    )


async def run_tool(nc: NATSClient, name: str, args: Any) -> str:
    """Run a tool the model asked for. The whole point: one request to the service."""
    if name != "read_sensor":
        return f"error: unknown tool '{name}'"
    # Most models hand back parsed arguments; some return a JSON string instead.
    try:
        parsed: Any = json.loads(args) if isinstance(args, str) else args
    except json.JSONDecodeError:
        parsed = {}
    location = ""
    if isinstance(parsed, dict):
        loc = parsed.get("location")
        if isinstance(loc, str):
            location = loc
    reply = await nc.request(SENSOR_SUBJECT, location.encode(), timeout=5.0)
    value = reply.data.decode()
    return f"no sensor at '{location}'" if value == "unknown" else f"{location} is {value}°C"


async def chat(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """One non-streamed turn — used for the tool-decision round, for a clean tool_calls array."""
    async with httpx.AsyncClient(timeout=None) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/chat",
            json={"model": MODEL, "messages": messages, "tools": TOOLS, "stream": False},
        )
        resp.raise_for_status()
        body: dict[str, Any] = resp.json()
        message: dict[str, Any] = body.get("message", {})
        return message


async def chat_stream(messages: list[dict[str, Any]]) -> AsyncGenerator[str, None]:
    """Final turn — stream the model's answer token by token (no tools needed)."""
    async with (
        httpx.AsyncClient(timeout=None) as client,
        client.stream(
            "POST",
            f"{OLLAMA_URL}/api/chat",
            json={"model": MODEL, "messages": messages, "stream": True},
        ) as resp,
    ):
        resp.raise_for_status()
        async for line in resp.aiter_lines():
            if not line.strip():
                continue
            # A rare malformed line shouldn't crash the stream — skip it.
            try:
                token = (json.loads(line).get("message") or {}).get("content", "")
            except json.JSONDecodeError:
                continue
            if token:
                yield token


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="LLM agent with a read_sensor tool backed by a NATS microservice."
    )
    add_connection_flags(parser)
    add_agent_identity_flags(parser, agent="tools")
    args = parser.parse_args()

    nc = await connect_from_cli(args)

    # Start the microservice the agent's tool will call. In production this is a
    # separate process somewhere on the network — here it just shares `nc`.
    await start_sensor_service(nc)

    service = AgentService(
        agent="tools",
        owner=args.owner,
        session_name=args.session_name,
        nc=nc,
        description="LLM agent with a read_sensor tool backed by a NATS microservice",
        heartbeat_interval_s=args.heartbeat_interval,
    )

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        messages: list[dict[str, Any]] = [{"role": "user", "content": envelope.prompt}]

        # Round 1 — does the model want a tool? (non-streamed, for clean tool_calls)
        decision = await chat(messages)
        messages.append(decision)

        # Run whatever tools the model asked for, appending each result. (One
        # round is plenty for this demo; a fuller agent would loop until the
        # model stops requesting tools.)
        tool_calls = decision.get("tool_calls") or []
        for call in tool_calls:
            fn = call.get("function", {})
            result = await run_tool(nc, fn.get("name", ""), fn.get("arguments", {}))
            # No tool_call_id: Ollama's /api/chat returns no tool-call ids and
            # correlates each result to its call by order.
            messages.append({"role": "tool", "content": result})

        # No tool needed → round 1 was already the answer.
        if not tool_calls:
            await stream.send(decision.get("content", ""))
            return

        # Round 2 — the model now has the sensor reading; stream its final answer.
        async for token in chat_stream(messages):
            await stream.send(token)

    service.on_prompt(handler)
    await service.start()
    print(f"tools agent listening on {service.subject.prompt}")
    print(f"sensor service on '{SENSOR_SUBJECT}', model '{MODEL}' at {OLLAMA_URL}")
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
