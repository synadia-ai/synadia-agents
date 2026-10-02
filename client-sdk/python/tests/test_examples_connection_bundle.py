"""The runnable client examples use the SDK connection bundle as their only auth seam."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import pytest
from examples import _connect_cli as connect_cli

if TYPE_CHECKING:
    from tests.conftest import NkeyUser


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    connect_cli.add_connection_flags(parser)
    connect_cli.add_identity_flags(parser)
    return parser


def test_connection_credentials_work_with_identity_off(
    tmp_path: Path, identity_keys: dict[str, NkeyUser]
) -> None:
    seed_file = tmp_path / "alice.nk"
    seed_file.write_text(identity_keys["alice"].seed + "\n", encoding="utf-8")

    bundle = connect_cli._resolve_bundle(
        _parser().parse_args(["--url", "nats://localhost:4222", "--nkey", str(seed_file)])
    )
    assert bundle.signer is None
    assert bundle.connection_options["nkeys_seed_str"] == identity_keys["alice"].seed
    bundle.wipe()


def test_signed_mode_reuses_the_connection_snapshot(
    tmp_path: Path, identity_keys: dict[str, NkeyUser]
) -> None:
    seed_file = tmp_path / "alice.nk"
    seed_file.write_text(identity_keys["alice"].seed + "\n", encoding="utf-8")

    args = _parser().parse_args(
        [
            "--url",
            "nats://localhost:4222",
            "--nkey",
            str(seed_file),
            "--sender-identity",
            "signed",
            "--sender-name",
            "example-client",
        ]
    )
    bundle = connect_cli._resolve_bundle(args)
    assert bundle.signer is not None
    assert bundle.signer.public_key == identity_keys["alice"].public

    connection = connect_cli.ExampleNatsConnection(
        nc=cast(Any, None),  # no network is needed to construct the identity view
        bundle=bundle,
        sender_name=args.sender_name,
    )
    assert connection.identity is not None
    assert connection.identity.signer is bundle.signer
    assert connection.identity.name == "example-client"
    bundle.wipe()


def test_invalid_sender_identity_env_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NATS_SENDER_IDENTITY", "maybe")
    with pytest.raises(SystemExit):
        _parser().parse_args([])
