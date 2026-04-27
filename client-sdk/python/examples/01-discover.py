"""Enumerate every reachable agent and print a summary.

Mirrors ``examples/01-discover.ts`` in the TS SDK — useful as a quick
sanity check when bringing up a new environment.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from examples._connect_cli import add_connection_flags, connect_from_cli
from natsagent import Agents


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="List every protocol-compliant agent on the NATS bus."
    )
    add_connection_flags(parser)
    args = parser.parse_args()

    nc = await connect_from_cli(args)
    agents = Agents(nc=nc)
    try:
        found = await agents.discover()
        if not found:
            print("no agents found.")
            return
        print(f"found {len(found)} agent(s):\n")
        for a in found:
            ep = a.prompt_endpoint
            print(f"  {a.agent}/{a.owner}/{a.name}")
            print(f"    instance_id:      {a.instance_id}")
            print(f"    protocol_version: {a.protocol_version or 'unspecified'}")
            print(f"    version:          {a.version or 'unspecified'}")
            print(f"    description:      {a.description}")
            print(f"    prompt subject:   {ep.subject}")
            print(
                "    max_payload:      "
                + (str(ep.max_payload_bytes) if ep.max_payload_bytes is not None else "unspecified")
            )
            print(
                "    attachments_ok:   "
                + (str(ep.attachments_ok) if ep.attachments_ok is not None else "unspecified")
            )
            print()
    finally:
        await agents.close()
        await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
