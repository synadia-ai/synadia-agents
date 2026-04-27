"""Session-pinned interactive chat against the first discovered agent.

A thin REPL that keeps one NATS connection and one ``Agent`` alive across
many ``prompt()`` calls — each turn is still an independent protocol
request, mirroring what you'd get by running ``02-prompt-text.py`` repeatedly
by hand. The point is to show multi-turn conversation flow, **not** to
introduce any new SDK state.

Two session modes:

1. **Subject-level session (default).** Without ``--session``, the agent's
   NATS subject IS the session boundary (§2 + §3.2). Session-aware harnesses
   like claude-code / pi register each session as its own subject, so
   repeated prompts to the same discovered subject just work as a chat.
2. **Envelope-level session (``--session NAME``).** For agents that
   multiplex multiple conversations over one subject (Hermes-style), the
   caller tags each request with the conversation label (§5.1).

The reference agent supports both — running ``--session alice`` and
``--session bob`` in separate REPLs yields two independent conversations
hitting the same subject.

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


def _banner(session: str | None, agent_identity: str, turns: int) -> Panel:
    label = f"session: [bold cyan]{session}[/]" if session else "[dim]subject-level session[/]"
    body = Text.from_markup(f"  agent: [bold]{agent_identity}[/]  ·  protocol 0.1  ·  turn {turns}")
    return Panel(body, title=label, title_align="left", border_style="cyan")


def _prompt_marker(session: str | None) -> str:
    return f"[{session}] ❯ " if session else "❯ "  # noqa: RUF001 — prompt glyph by intent


async def _run_turn(
    console: Console,
    agent: Agent,
    text: str,
    session: str | None,
    agent_name: str,
    timeout: float,
) -> None:
    """Publish one prompt and stream the response to the console.

    Ctrl-C cancels the in-flight stream (drops the subscription per §6.7) and
    returns control to the REPL — the session stays live. Mid-stream
    protocol errors surface red and the loop continues.
    """
    console.print(Text(f"  {agent_name}  ", style="bold green"), end="")
    thinking = console.status("agent is thinking…", spinner="dots")
    thinking.start()
    first_chunk = True
    try:
        stream = agent.prompt(text, session=session, timeout=timeout)
        async for msg in stream:
            if first_chunk:
                thinking.stop()
                first_chunk = False
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
                # A session chat REPL is not the right place for interactive
                # query handling — send a safe default so the agent's stream
                # can finish. Users wanting query interaction should use
                # `04-query-reply.py` instead.
                console.print(
                    Text(f"\n  [agent asked: {msg.prompt}; replying 'ok']", style="yellow")
                )
                await msg.reply("ok")
    except asyncio.CancelledError:
        if not first_chunk:
            console.print(Text("\n  [turn cancelled]", style="yellow"))
        else:
            console.print(Text("[turn cancelled]", style="yellow"))
        raise
    except NatsAgentError as err:
        if not first_chunk:
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
            "Interactive session-pinned chat. Without --session you get a "
            "subject-level chat (the agent subject IS the session); with "
            "--session NAME you drive one of many envelope-level conversations "
            "multiplexed over the same subject."
        )
    )
    parser.add_argument(
        "--session",
        default=None,
        metavar="NAME",
        help=(
            "Optional conversation label on the request envelope (§5.1). "
            "Only needed for agents that multiplex multiple conversations over "
            "one NATS subject (Hermes-style). Omit it for subject-level chat."
        ),
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
        identity = f"{chosen.agent}/{chosen.owner}/{chosen.name or '<custom>'}"
        agent_name = chosen.agent

        turns = 0
        console.print(_banner(args.session, identity, turns))
        console.print(Text("  type /help for commands, /quit to exit.", style="dim"))
        console.print()

        while True:
            try:
                raw = await asyncio.to_thread(input, _prompt_marker(args.session))
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
                console.print(_banner(args.session, identity, turns))
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
                    args.session,
                    agent_name,
                    args.timeout,
                )
            except asyncio.CancelledError:
                # Caller hit Ctrl-C mid-stream — stay in the REPL.
                continue
            turns += 1

        label = f"session '{args.session}'" if args.session else "chat"
        console.print(Text(f"{label} ended — {turns} turn(s).", style="dim"))
    finally:
        await agents.close()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
