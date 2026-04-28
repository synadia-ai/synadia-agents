"""Prompt an agent with a file attached.

Mirrors ``examples/03-prompt-attachment.ts`` — demonstrates the boss's
pitch: ``prompt("describe this photo", attachments=[...])``. §5.4
validation runs locally BEFORE any NATS traffic when the agent's prompt
endpoint declared ``attachments_ok: false`` or ``max_payload`` is
exceeded.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import add_connection_flags, connect_from_cli
from synadia_ai.agents import (
    Agents,
    Attachment,
    AttachmentsNotSupportedError,
    DiscoverFilter,
    NatsAgentError,
    PayloadTooLargeError,
    Query,
    ResponseChunk,
    StatusChunk,
)


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prompt the first discovered agent with a file attachment."
    )
    parser.add_argument("path", help="file to attach")
    parser.add_argument(
        "--prompt",
        default="describe this photo",
        help="prompt text (default: 'describe this photo')",
    )
    parser.add_argument(
        "--session",
        default=None,
        metavar="NAME",
        help=(
            "Select the agent whose `session_name` matches NAME — i.e. the "
            "5th subject token (v0.3). When omitted, the first discovered "
            "agent is used."
        ),
    )
    add_connection_flags(parser)
    args = parser.parse_args()

    attachment_path = Path(args.path)
    if not attachment_path.is_file():
        print(f"no such file: {attachment_path}", file=sys.stderr)
        sys.exit(1)

    nc = await connect_from_cli(args)
    agents = Agents(nc=nc)
    try:
        filt = DiscoverFilter(session_name=args.session) if args.session else None
        found = await agents.discover(filter=filt)
        if not found:
            print("no agents reachable — start the reference agent first", file=sys.stderr)
            sys.exit(2)

        chosen = found[0]
        ep = chosen.prompt_endpoint
        mp = ep.max_payload_bytes if ep.max_payload_bytes is not None else "unspecified"
        ao = ep.attachments_ok if ep.attachments_ok is not None else "unspecified"
        print(
            f"prompting {chosen.agent}/{chosen.owner}/{chosen.session_name} "
            f"(max_payload={mp}, attachments_ok={ao})"
        )

        attachment = Attachment.from_path(attachment_path)
        try:
            stream = chosen.prompt(args.prompt, attachments=[attachment])
            async for msg in stream:
                if isinstance(msg, ResponseChunk):
                    sys.stdout.write(msg.text)
                    sys.stdout.flush()
                    if msg.attachments:
                        names = ", ".join(a.filename for a in msg.attachments)
                        print(f"\n  [agent returned {len(msg.attachments)} attachment(s): {names}]")
                elif isinstance(msg, StatusChunk):
                    if msg.status == "done":
                        print("\n[done]")
                elif isinstance(msg, Query):
                    print(f"\n[agent asks: {msg.prompt}]")
                    await msg.reply("ok")
        except AttachmentsNotSupportedError:
            print(
                "\nthis agent does not accept attachments (attachments_ok=false)",
                file=sys.stderr,
            )
            sys.exit(3)
        except PayloadTooLargeError as err:
            print(
                f"\npayload is too large: {err.actual} bytes > agent's {err.limit} byte limit",
                file=sys.stderr,
            )
            sys.exit(4)
    except NatsAgentError as err:
        print(f"demo failed: {type(err).__name__}: {err}", file=sys.stderr)
        sys.exit(99)
    finally:
        await agents.close()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
