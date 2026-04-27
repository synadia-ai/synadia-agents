"""Python counterpart to the TS SDK's ``_run-reference-agent.ts``.

Run this in one terminal, point the numbered example scripts at it from
another. The agent simply echoes the received prompt back (prefixed) and
optionally saves any inbound attachments to a local directory.

Usage::

    uv run python examples/_reference_agent.py --url nats://127.0.0.1:4222

Or with a `nats` CLI context selected::

    uv run python examples/_reference_agent.py --context dev

Flags::

    --prefix TEXT                   prepended to echoed prompt text
    --save-attachments-to-dir[=DIR] absent → don't save; bare flag → default tmp dir
    --agent NAME                    2nd subject token (default: demo-agent)
    --owner NAME                    3rd token  (default: $USER)
    --name NAME                     4th token  (default: example)
    --heartbeat-interval SECONDS    default 5 (matches TS ref agent)
    --description TEXT              service description
    --context NAME / --url URL      shared connection flags
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
from collections import deque
from pathlib import Path
from types import FrameType

# Make `examples._connect_cli` importable whether the script is launched as
# `python examples/_reference_agent.py` or `python -m examples._reference_agent`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import add_connection_flags, connect_from_cli
from natsagent import AgentService, Envelope, PromptStream

log = logging.getLogger("natsagent.examples.reference")

DEFAULT_SAVE_DIR = "/tmp/natsagent-ref/attachments"

# Per-session turn cap — keeps long-running demos honest about memory. In-process,
# dies with the agent; persistence is a real harness's concern.
HISTORY_CAP = 20


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Spec-compliant reference agent for the natsagent example scripts."
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
        "--owner",
        default=os.environ.get("USER", "anon"),
        help="§2 `owner` token (default: $USER)",
    )
    parser.add_argument("--name", default="example", help="§2 `name` token (default: example)")
    parser.add_argument(
        "--heartbeat-interval",
        type=int,
        default=5,
        help="heartbeat interval in seconds (default: 5)",
    )
    parser.add_argument(
        "--description",
        default="python reference agent",
        help="§3 service description (default: 'python reference agent')",
    )
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

    # Per-session conversation memory. Keyed on envelope.session; the None
    # bucket is the shared "no session label given" bucket — callers hitting
    # this agent subject without --session share one chat, which is the
    # subject-level session pattern (protocol §2 + §3.2: session-aware
    # harnesses like claude-code/pi register one agent per session, so the
    # subject IS the session boundary).
    #
    # Callers using --session NAME get their own bucket on the SAME subject —
    # that's the envelope-level multiplexing pattern (§5.1) for harnesses
    # that run one registration for many conversations (Hermes-style).
    history: dict[str | None, deque[str]] = {}

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        bucket_key = envelope.session  # may be None
        bucket = history.setdefault(bucket_key, deque(maxlen=HISTORY_CAP))
        prior_turns = list(bucket)
        bucket.append(envelope.prompt)

        if envelope.session is not None:
            log.info(
                "received session=%r (turn %d, %d in memory)",
                envelope.session,
                len(bucket),
                len(prior_turns),
            )

        echoed = f"{args.prefix}{envelope.prompt}"
        if envelope.session is not None:
            echoed += f" [session: {envelope.session}]"
        if prior_turns:
            label = f"session '{envelope.session}'" if envelope.session else "this subject"
            recap = "; ".join(f'"{t}"' for t in prior_turns)
            echoed += f" (turn {len(bucket)} in {label}; you previously said: {recap})"
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
        name=args.name,
        nc=nc,
        description=args.description,
        heartbeat_interval_s=args.heartbeat_interval,
    )
    agent.on_prompt(handler)
    await agent.start()

    print(f"reference agent listening on {agent.subject.inbox}")
    print("press Ctrl+C to stop")

    stop = asyncio.Event()

    def _on_signal(_sig: int, _frame: FrameType | None) -> None:
        stop.set()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    try:
        await stop.wait()
    finally:
        print("\nshutting down…")
        await agent.stop()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
