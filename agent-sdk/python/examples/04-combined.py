# 04 · LLM agent (combined) — answers prompts with Ollama OR OpenRouter.
#
# Step 4 of the ladder, and the reusable base later agents build on. It defers
# all model access to llm.py, which auto-selects a backend from the environment.
# Python mirror of agent-sdk/typescript/examples/04-combined.ts.
#
#   OPENROUTER_API_KEY set  → OpenRouter (OPENROUTER_MODEL)
#   otherwise               → local Ollama (OLLAMA_MODEL, OLLAMA_URL)
#
# Identity via --owner/--session-name, else the SYNADIA_* ladder
# ($SYNADIA_LLM_OWNER > $SYNADIA_OWNER > legacy $NATS_AGENT_OWNER, and the _NAME
# analogue — this example registers agent="llm"). --heartbeat-interval /
# $NATS_AGENT_HEARTBEAT_INTERVAL tunes the cadence. Connection: --context/--url,
# else $NATS_CONTEXT/$NATS_URL, else the selected `nats` context. Run -h for flags.

from __future__ import annotations

import argparse
import asyncio
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from synadia_ai.agents import Envelope

from examples._connect_cli import (
    add_agent_identity_flags,
    add_connection_flags,
    connect_from_cli,
)
from examples.llm import create_llm_client
from synadia_ai.agent_service import AgentService, PromptStream


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="LLM agent — answers prompts via Ollama or OpenRouter (auto-selected)."
    )
    add_connection_flags(parser)
    add_agent_identity_flags(parser, agent="llm")
    args = parser.parse_args()

    llm = create_llm_client()
    nc = await connect_from_cli(args)

    service = AgentService(
        agent="llm",
        owner=args.owner,
        session_name=args.session_name,
        nc=nc,
        description=f"LLM agent — answers prompts via {llm.label}",
        heartbeat_interval_s=args.heartbeat_interval,
    )

    # Wrap the prompt as a single user message and stream the model's reply. A
    # tool-calling agent (see 05-tools.py) extends this same pattern — adding a
    # non-streamed round-trip for tool dispatch before the final streamed answer.
    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        async for token in llm.chat_stream([{"role": "user", "content": envelope.prompt}]):
            await stream.send(token)

    service.on_prompt(handler)
    await service.start()
    print(f"llm agent listening on {service.subject.prompt}")
    print(f"backend: {llm.label}")
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
