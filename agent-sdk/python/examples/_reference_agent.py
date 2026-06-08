"""Python counterpart to the TS SDK's ``_run-reference-agent.ts``.

Run this in one terminal, point the numbered example scripts in
``client-sdk/python/examples/`` at it from another. The agent simply
echoes the received prompt back (prefixed) and optionally saves any
inbound attachments to a local directory. Under v0.3 the subject IS
the session — this agent serves whichever session the caller specifies
via ``--session-name``.

Usage::

    uv run python examples/_reference_agent.py --url nats://127.0.0.1:4222

Or with a `nats` CLI context selected::

    uv run python examples/_reference_agent.py --context dev

Flags::

    --prefix TEXT                   prepended to echoed prompt text
    --save-attachments-to-dir[=DIR] absent → don't save; bare flag → default tmp dir
    --agent NAME                    3rd subject token (default: demo-agent)
    --owner NAME                    4th token  (default: $USER)
    --session-name NAME             5th token / session this agent serves (default: example)
    --heartbeat-interval SECONDS    default 5 (matches TS ref agent)
    --description TEXT              service description
    --context NAME / --url URL      shared connection flags
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys
from collections import deque
from pathlib import Path

# Make `examples._connect_cli` importable whether the script is launched as
# `python examples/_reference_agent.py` or `python -m examples._reference_agent`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from synadia_ai.agents import Envelope

from examples._connect_cli import (
    add_agent_identity_flags,
    add_connection_flags,
    connect_from_cli,
)
from synadia_ai.agent_service import AgentService, PromptStream

log = logging.getLogger("synadia_ai.agent_service.examples.reference")

DEFAULT_SAVE_DIR = "/tmp/synadia-ai-agents-ref/attachments"

# Per-session turn cap — keeps long-running demos honest about memory. In-process,
# dies with the agent; persistence is a real harness's concern.
HISTORY_CAP = 20


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Spec-compliant reference agent for the synadia-ai-agents example scripts."
    )
    parser.add_argument(
        "--prefix",
        default="echo: ",
        help='prepended to echoed prompts (default: "echo: ")',
    )
    parser.add_argument(
        "--save-attachments-to-dir",
        nargs="?",
        const=DEFAULT_SAVE_DIR,
        default=None,
        metavar="DIR",
        help=(
            f"save inbound attachments to DIR (default {DEFAULT_SAVE_DIR} "
            "when the flag is given without a value; omit to drop attachments)"
        ),
    )
    parser.add_argument(
        "--agent",
        default="demo-agent",
        help="§2 `agent` token (default: demo-agent)",
    )
    parser.add_argument(
        "--description",
        default="python reference agent",
        help="§3 service description (default: 'python reference agent')",
    )
    # --owner / --session-name / --heartbeat-interval, each defaulting to its
    # NATS_AGENT_* env var (so the reference agent is env-driven like the
    # numbered examples). The reference agent keeps its own fallbacks: session
    # "example" and a snappy 5s heartbeat (vs. the ladder's "main" / 30s).
    add_agent_identity_flags(parser, session_fallback="example", heartbeat_fallback=5)
    add_connection_flags(parser)
    return parser.parse_args()


def _save_attachment(save_dir: Path, filename: str, data: bytes) -> Path:
    """Write ``data`` to ``save_dir/<basename(filename)>``; reject unsafe names."""
    safe = Path(filename).name
    if safe in ("", ".", ".."):
        # Bubbles up as ValueError → SDK emits §9.1 400.
        raise ValueError(f"refusing unsafe attachment filename: {filename!r}")
    dest = save_dir / safe
    dest.write_bytes(data)
    return dest


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    args = _parse_args()

    save_dir: Path | None = None
    if args.save_attachments_to_dir is not None:
        save_dir = Path(args.save_attachments_to_dir)
        save_dir.mkdir(parents=True, exist_ok=True)
        log.info("saving inbound attachments to %s", save_dir.resolve())

    nc = await connect_from_cli(args)

    # Single conversation memory — under v0.3 this service registration
    # serves a single session (the 5th subject token), so one bucket suffices.
    history: deque[str] = deque(maxlen=HISTORY_CAP)

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        prior_turns = list(history)
        history.append(envelope.prompt)

        echoed = f"{args.prefix}{envelope.prompt}"
        if prior_turns:
            recap = "; ".join(f'"{t}"' for t in prior_turns)
            echoed += f" (turn {len(history)}; you previously said: {recap})"
        if envelope.attachments:
            names = ", ".join(a.filename for a in envelope.attachments)
            echoed += f" [received {len(envelope.attachments)} attachment(s): {names}]"
            if save_dir is not None:
                for attachment in envelope.attachments:
                    raw = attachment.to_bytes()
                    dest = _save_attachment(save_dir, attachment.filename, raw)
                    log.info(
                        "saved attachment %s (%d bytes) -> %s",
                        attachment.filename,
                        len(raw),
                        dest.resolve(),
                    )
        await stream.send(echoed)

    agent = AgentService(
        agent=args.agent,
        owner=args.owner,
        session_name=args.session_name,
        nc=nc,
        description=args.description,
        heartbeat_interval_s=args.heartbeat_interval,
    )
    agent.on_prompt(handler)
    await agent.start()

    print(f"reference agent listening on {agent.subject.prompt}")
    print("press Ctrl+C to stop")

    # add_signal_handler is the asyncio-safe way to wake `await stop.wait()`
    # (matches the numbered ladder examples).
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for _sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(_sig, stop.set)

    try:
        await stop.wait()
    finally:
        print("\nshutting down…")
        await agent.stop()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
