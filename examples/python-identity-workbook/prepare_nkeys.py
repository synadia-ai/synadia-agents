"""Generate the workbook's three throwaway local NKEY users and server config."""

from __future__ import annotations

import argparse
import secrets
from dataclasses import dataclass
from pathlib import Path

import nkeys

from _common import WORKBOOK_DIR

ROLES = ("echo", "hello", "cli")


@dataclass(frozen=True, slots=True)
class ProvisionedUser:
    role: str
    public_key: str
    seed_path: Path


@dataclass(frozen=True, slots=True)
class ProvisionedNkeys:
    users: tuple[ProvisionedUser, ...]
    config_path: Path

    def user(self, role: str) -> ProvisionedUser:
        return next(user for user in self.users if user.role == role)


def provision(output_dir: Path) -> ProvisionedNkeys:
    """Create fresh users in a new directory; never print or return raw seeds."""
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    users: list[ProvisionedUser] = []
    for role in ROLES:
        seed = nkeys.encode_seed(secrets.token_bytes(32), nkeys.PREFIX_BYTE_USER)
        key_pair = nkeys.from_seed(bytearray(seed))
        try:
            public_key = key_pair.public_key.decode("ascii")
        finally:
            key_pair.wipe()
        seed_path = output_dir / f"{role}.nkey"
        seed_path.write_bytes(seed + b"\n")
        seed_path.chmod(0o600)
        users.append(ProvisionedUser(role=role, public_key=public_key, seed_path=seed_path))

    lines = [
        "# Generated throwaway users for examples/python-identity-workbook.",
        "# The private seed files stay next to this config and are gitignored.",
        "authorization {",
        "  users: [",
        *(f'    {{ nkey: "{user.public_key}" }}' for user in users),
        "  ]",
        "}",
        "",
    ]
    config_path = output_dir / "nats-server.conf"
    config_path.write_text("\n".join(lines), encoding="utf-8")
    return ProvisionedNkeys(users=tuple(users), config_path=config_path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=WORKBOOK_DIR / ".local",
        help="new directory for seed files and nats-server.conf (default: .local)",
    )
    args = parser.parse_args()
    try:
        prepared = provision(args.output)
    except FileExistsError:
        parser.error(
            f"{args.output} already exists; keep it to reuse these identities, "
            "or remove that directory before generating a new set"
        )

    print(f"prepared three separate local NKEY users in {args.output.resolve()}")
    for user in prepared.users:
        print(f"  {user.role}: $G.{user.public_key}")
    print(f"server config: {prepared.config_path.resolve()}")
    print("private seeds were written to mode-0600 files and were not printed")


if __name__ == "__main__":
    main()
