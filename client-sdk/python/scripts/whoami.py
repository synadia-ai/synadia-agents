"""Print the connection's own agent ID (``self_id``) — a sender-identity diagnostic.

Resolves a connection exactly like the numbered examples do (``--context``,
``--url``, ``$NATS_URL``, the selected context), optionally with a
signer (``--nkey`` / ``--creds``, or ``$NATS_NKEY_SEED_FILE`` /
``$NATS_CREDS``). Pass ``--sender-identity signed`` to derive the signer
from that same connection snapshot. The script asks ``Agents.self_id()``
and prints the result or the error that explains why identity is unavailable.

Usage::

    uv run python scripts/whoami.py --url nats://127.0.0.1:4222 \
        --nkey ~/alice.nk --sender-identity signed
    uv run python scripts/whoami.py --context ngs --sender-identity signed
    uv run python scripts/whoami.py --url nats://127.0.0.1:4222   # no-auth → NoIdentityError

Exit code 0 when an identity was resolved, 1 when the connection has no
usable identity (``NoIdentityError`` / ``IdentityUnavailableError`` /
``IdentityMismatchError``), 2 on a usage error.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

# The examples' connection resolver is a script-side helper, not part of the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import (
    add_connection_flags,
    add_identity_flags,
    open_agents_from_cli,
)

from synadia_ai.agents import IdentityError


async def _run(args: argparse.Namespace) -> int:
    session = await open_agents_from_cli(args)
    connection = session.connection
    try:
        signer = connection.signer
        from_jwt = signer is not None and signer.jwt
        source = "credentials JWT" if from_jwt else "$SYS.REQ.USER.INFO"
        print(f"signer:   {signer if signer is not None else 'none (identity off)'}")
        print(f"source:   {source}")
        try:
            id = await session.agents.self_id()
        except IdentityError as exc:
            print(f"identity: none — {exc}")
            return 1
        print(f"identity: {id}")
        print(f"account:  {id.account}")
        print(f"user:     {id.user}")
        return 0
    finally:
        await session.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Print this connection's agent ID (self_id).")
    add_connection_flags(parser)
    add_identity_flags(parser)
    return asyncio.run(_run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
