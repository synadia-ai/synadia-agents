"""Interactive multi-turn chat against the first discovered agent.

A thin REPL that keeps one NATS connection and one ``Agent`` alive across
many ``prompt()`` calls — each turn is still an independent protocol
request, mirroring what you'd get by running ``02-prompt-text.py`` repeatedly
by hand. The point is to show multi-turn conversation flow, **not** to
introduce any new SDK state.

One chat = one session = one subject. Under v0.3 the 5th subject token
IS the session (``agents.prompt.{a}.{o}.{session_name}``), so repeated
prompts to the same discovered agent just work as a chat. To run two
independent conversations against the same agent, register two services
with different ``session_name`` values and select between them via
discovery.

Requires ``rich``::

    uv sync --extra examples
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import readline  # noqa: F401 — imported for its side effect: arrow-key history on input()
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import add_connection_flags, connect_from_cli
from synadia_ai.agents import (
    Agent,
    Agents,
    NatsAgentError,
    Query,
    ResponseChunk,
    StatusChunk,
)

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.text import Text
except ImportError:
    sys.stderr.write("this example requires `rich` — run `uv sync --extra examples` first.\n")
    sys.exit(3)


SlashAction = Literal["quit", "clear", "help", "continue", "send"]


@dataclass(frozen=True)
class ParsedInput:
    """Outcome of parsing one line of REPL input.

    ``action`` describes what the REPL should do; ``text`` carries the
    prompt payload for ``action == "send"`` (empty otherwise). Factoring
    this out lets the parser be a pure function — see
    ``tests/test_chat_commands.py``.
    """

    action: SlashAction
    text: str = ""


def parse_input(line: str) -> ParsedInput:
    """Classify one line of user input into a REPL action.

    Empty / whitespace-only lines are a no-op (``continue``). Lines starting
    with ``/`` are slash commands; unknown commands fall through to
    ``help`` so the user sees the command list instead of accidentally
    sending ``/foo`` as a prompt. Anything else is a prompt to send.
    """
    stripped = line.strip()
    if not stripped:
        return ParsedInput(action="continue")
    if stripped.startswith("/"):
        cmd = stripped.lstrip("/").lower()
        if cmd in ("quit", "q", "exit"):
            return ParsedInput(action="quit")
        if cmd == "clear":
            return ParsedInput(action="clear")
        if cmd in ("help", "?"):
            return ParsedInput(action="help")
        return ParsedInput(action="help")
    return ParsedInput(action="send", text=stripped)


def _banner(session_name: str, agent_identity: str, turns: int) -> Panel:
    label = f"session: [bold cyan]{session_name}[/]"
    body = Text.from_markup(f"  agent: [bold]{agent_identity}[/]  ·  turn {turns}")
    return Panel(body, title=label, title_align="left", border_style="cyan")


def _prompt_marker() -> str:
    return "❯ "  # noqa: RUF001 — prompt glyph by intent


async def _run_turn(
    console: Console,
    agent: Agent,
    text: str,
    agent_name: str,
    timeout: float,
) -> None:
    """Publish one prompt and stream the response to the console.

    Ctrl-C cancels the in-flight stream (drops the subscription per §6.7) and
    returns control to the REPL — the chat stays live. Mid-stream
    protocol errors surface red and the loop continues.
    """
    console.print(Text(f"  {agent_name}  ", style="bold green"), end="")
    thinking = console.status("agent is thinking…", spinner="dots")
    thinking.start()
    first_visible_chunk = True
    try:
        stream = agent.prompt(text, timeout=timeout)
        async for msg in stream:
            # Keep the spinner spinning through the §6.4 leading ack (and any
            # mid-stream keep-alive acks) so the user sees "thinking…" until
            # the agent's actual text starts arriving. Without this the
            # spinner stops within milliseconds of `await stream.__aiter__()`,
            # leaving a visible silent gap before the first response chunk.
            if first_visible_chunk and not isinstance(msg, StatusChunk):
                thinking.stop()
                first_visible_chunk = False
            if isinstance(msg, ResponseChunk):
                console.print(msg.text, end="", highlight=False)
                if msg.attachments:
                    names = ", ".join(a.filename for a in msg.attachments)
                    console.print(
                        Text(
                            f"\n  [agent returned {len(msg.attachments)} attachment(s): {names}]",
                            style="dim",
                        )
                    )
            elif isinstance(msg, StatusChunk):
                pass  # status chunks are informational; nothing to render
            elif isinstance(msg, Query):
                # A chat REPL is not the right place for interactive query
                # handling — send a safe default so the agent's stream can
                # finish. Users wanting query interaction should use
                # `04-query-reply.py` instead.
                console.print(
                    Text(f"\n  [agent asked: {msg.prompt}; replying 'ok']", style="yellow")
                )
                await msg.reply("ok")
    except asyncio.CancelledError:
        if not first_visible_chunk:
            console.print(Text("\n  [turn cancelled]", style="yellow"))
        else:
            console.print(Text("[turn cancelled]", style="yellow"))
        raise
    except NatsAgentError as err:
        if not first_visible_chunk:
            console.print()
        console.print(Text(f"  [{type(err).__name__}: {err}]", style="bold red"))
        return
    finally:
        with contextlib.suppress(Exception):
            thinking.stop()
    console.print()  # newline after the agent's streamed text


async def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Interactive chat against the first discovered agent. Under v0.3 "
            "the 5th subject token IS the session — one chat = one session "
            "= one subject. Pick a different session by registering an agent "
            "with a different `session_name`."
        )
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        metavar="SECONDS",
        help="per-chunk inactivity timeout (default: 60s, matches §6.6)",
    )
    add_connection_flags(parser)
    args = parser.parse_args()

    console = Console()
    nc = await connect_from_cli(args)
    agents = Agents(nc=nc)
    try:
        found = await agents.discover()
        if not found:
            console.print("[red]no agents discovered — start the reference agent first.[/]")
            sys.exit(2)
        chosen = found[0]
        identity = f"{chosen.agent}/{chosen.owner}/{chosen.session_name or '<custom>'}"
        agent_name = chosen.agent

        turns = 0
        console.print(_banner(chosen.session_name or "<custom>", identity, turns))
        console.print(Text("  type /help for commands, /quit to exit.", style="dim"))
        console.print()

        while True:
            try:
                raw = await asyncio.to_thread(input, _prompt_marker())
            except EOFError:
                console.print()
                break
            except KeyboardInterrupt:
                # Ctrl-C at an empty prompt exits; otherwise readline already
                # cleared the in-progress line.
                console.print()
                break

            parsed = parse_input(raw)
            if parsed.action == "continue":
                continue
            if parsed.action == "quit":
                break
            if parsed.action == "clear":
                console.clear()
                console.print(_banner(chosen.session_name or "<custom>", identity, turns))
                continue
            if parsed.action == "help":
                console.print(
                    Text.from_markup(
                        "  [bold]commands[/]: "
                        "[cyan]/quit[/] (or /q, /exit, Ctrl-D)  ·  "
                        "[cyan]/clear[/]  ·  [cyan]/help[/]"
                    )
                )
                continue

            # action == "send"
            try:
                await _run_turn(
                    console,
                    chosen,
                    parsed.text,
                    agent_name,
                    args.timeout,
                )
            except asyncio.CancelledError:
                # Caller hit Ctrl-C mid-stream — stay in the REPL.
                continue
            turns += 1

        console.print(Text(f"chat ended — {turns} turn(s).", style="dim"))
    finally:
        await agents.close()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
