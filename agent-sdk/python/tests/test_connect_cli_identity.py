"""Unit tests for the example identity resolver in ``examples/_connect_cli.py``.

The examples are not an importable package (the e2e test path-references
them), so we load the helper module straight off disk via
:func:`importlib.util.spec_from_file_location` and assert the
``SYNADIA_*`` precedence ladder that ``add_agent_identity_flags`` builds:

    --flag > SYNADIA_<AGENT>_<TOKEN> > SYNADIA_<TOKEN> > NATS_AGENT_<TOKEN>
            > ($USER for owner) > fallback

This is a pure-resolution test — no NATS connection is opened.
"""

from __future__ import annotations

import argparse
import importlib.util
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

if TYPE_CHECKING:
    from tests.conftest import NkeyUser

REPO_ROOT = Path(__file__).resolve().parent.parent
CONNECT_CLI_SCRIPT = REPO_ROOT / "examples" / "_connect_cli.py"

# Every identity env var the resolver reads, cleared before each test so a
# developer's shell env can't leak in.
_IDENTITY_ENV_VARS = (
    "SYNADIA_ECHO_OWNER",
    "SYNADIA_OWNER",
    "NATS_AGENT_OWNER",
    "USER",
    "SYNADIA_ECHO_NAME",
    "SYNADIA_NAME",
    "NATS_AGENT_NAME",
    "NATS_NKEY_SEED_FILE",
    "NATS_CREDS",
    "NATS_SENDER_IDENTITY",
)


def _load_connect_cli() -> Any:
    spec = importlib.util.spec_from_file_location("examples_connect_cli", CONNECT_CLI_SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def connect_cli() -> Any:
    return _load_connect_cli()


@pytest.fixture(autouse=True)
def _clean_identity_env(monkeypatch: Any) -> Iterator[None]:
    for name in _IDENTITY_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    yield


def _resolve(
    connect_cli: Any,
    *,
    agent: str | None,
    argv: Sequence[str] = (),
) -> argparse.Namespace:
    """Build a parser via the helper and resolve identity defaults from env."""
    parser = argparse.ArgumentParser()
    connect_cli.add_agent_identity_flags(parser, agent=agent)
    return parser.parse_args(list(argv))


def test_owner_ladder_per_agent(connect_cli: Any, monkeypatch: Any) -> None:
    monkeypatch.setenv("SYNADIA_ECHO_OWNER", "per-agent")
    monkeypatch.setenv("SYNADIA_OWNER", "fleet")
    monkeypatch.setenv("NATS_AGENT_OWNER", "legacy")
    monkeypatch.setenv("USER", "shelluser")

    # Per-agent var wins at the top of the ladder.
    assert _resolve(connect_cli, agent="echo").owner == "per-agent"

    # …then fleet-wide, then the legacy alias, then $USER, then "anon".
    monkeypatch.delenv("SYNADIA_ECHO_OWNER")
    assert _resolve(connect_cli, agent="echo").owner == "fleet"
    monkeypatch.delenv("SYNADIA_OWNER")
    assert _resolve(connect_cli, agent="echo").owner == "legacy"
    monkeypatch.delenv("NATS_AGENT_OWNER")
    assert _resolve(connect_cli, agent="echo").owner == "shelluser"
    monkeypatch.delenv("USER")
    assert _resolve(connect_cli, agent="echo").owner == "anon"


def test_name_ladder_per_agent(connect_cli: Any, monkeypatch: Any) -> None:
    monkeypatch.setenv("SYNADIA_ECHO_NAME", "per-agent")
    monkeypatch.setenv("SYNADIA_NAME", "fleet")
    monkeypatch.setenv("NATS_AGENT_NAME", "legacy")

    assert _resolve(connect_cli, agent="echo").session_name == "per-agent"
    monkeypatch.delenv("SYNADIA_ECHO_NAME")
    assert _resolve(connect_cli, agent="echo").session_name == "fleet"
    monkeypatch.delenv("SYNADIA_NAME")
    assert _resolve(connect_cli, agent="echo").session_name == "legacy"
    # Falls back to session_fallback ("main") once every env source is gone.
    monkeypatch.delenv("NATS_AGENT_NAME")
    assert _resolve(connect_cli, agent="echo").session_name == "main"


def test_agent_none_skips_per_agent_var(connect_cli: Any, monkeypatch: Any) -> None:
    """The reference-agent path (agent=None) ignores SYNADIA_<AGENT>_* vars."""
    monkeypatch.setenv("SYNADIA_ECHO_OWNER", "per-agent")
    monkeypatch.setenv("SYNADIA_OWNER", "fleet")
    monkeypatch.setenv("SYNADIA_ECHO_NAME", "per-agent-name")
    monkeypatch.setenv("SYNADIA_NAME", "fleet-name")

    args = _resolve(connect_cli, agent=None)
    assert args.owner == "fleet"
    assert args.session_name == "fleet-name"

    # Legacy aliases + fallback still honored on the agent=None path.
    monkeypatch.delenv("SYNADIA_OWNER")
    monkeypatch.delenv("SYNADIA_NAME")
    monkeypatch.setenv("NATS_AGENT_OWNER", "legacy")
    monkeypatch.setenv("NATS_AGENT_NAME", "legacy-name")
    args = _resolve(connect_cli, agent=None)
    assert args.owner == "legacy"
    assert args.session_name == "legacy-name"

    monkeypatch.delenv("NATS_AGENT_OWNER")
    monkeypatch.delenv("NATS_AGENT_NAME")
    monkeypatch.setenv("USER", "shelluser")
    args = _resolve(connect_cli, agent=None)
    assert args.owner == "shelluser"
    assert args.session_name == "main"


def test_explicit_flags_override_env(connect_cli: Any, monkeypatch: Any) -> None:
    monkeypatch.setenv("SYNADIA_ECHO_OWNER", "per-agent")
    monkeypatch.setenv("SYNADIA_ECHO_NAME", "per-agent-name")

    args = _resolve(
        connect_cli,
        agent="echo",
        argv=["--owner", "flag-owner", "--session-name", "flag-name"],
    )
    assert args.owner == "flag-owner"
    assert args.session_name == "flag-name"


def test_agent_env_token_maps_hyphens(connect_cli: Any, monkeypatch: Any) -> None:
    """A hyphenated agent token resolves to SYNADIA_<UPPER_SNAKE>_*."""
    assert connect_cli._agent_env_token("my-agent") == "MY_AGENT"
    monkeypatch.setenv("SYNADIA_MY_AGENT_OWNER", "per-agent")
    monkeypatch.setenv("SYNADIA_MY_AGENT_NAME", "per-agent-name")

    args = _resolve(connect_cli, agent="my-agent")
    assert args.owner == "per-agent"
    assert args.session_name == "per-agent-name"


# --- one connection-auth snapshot → optional host signer ------------------------


def test_connection_bundle_uses_nkey_once_and_identity_defaults_off(
    connect_cli: Any, monkeypatch: Any, tmp_path: Path, identity_keys: dict[str, NkeyUser]
) -> None:
    """The shared bundle owns both connection auth and the optional signer."""
    seed_file = tmp_path / "alice.nk"
    seed_file.write_text(identity_keys["alice"].seed + "\n", encoding="utf-8")

    parser = argparse.ArgumentParser()
    connect_cli.add_connection_flags(parser)
    connect_cli.add_identity_flags(parser)
    off = connect_cli._resolve_bundle(
        parser.parse_args(["--url", "nats://localhost:4222", "--nkey", str(seed_file)])
    )
    assert off.signer is None
    assert off.connection_options["nkeys_seed_str"] == identity_keys["alice"].seed
    off.wipe()

    monkeypatch.setenv("NATS_NKEY_SEED_FILE", str(seed_file))
    monkeypatch.setenv("NATS_SENDER_IDENTITY", "signed")
    parser = argparse.ArgumentParser()
    connect_cli.add_connection_flags(parser)
    connect_cli.add_identity_flags(parser)
    signed = connect_cli._resolve_bundle(parser.parse_args(["--url", "nats://localhost:4222"]))
    assert signed.signer is not None
    assert signed.signer.public_key == identity_keys["alice"].public
    assert signed.connection_options["nkeys_seed_str"] == identity_keys["alice"].seed
    signed.wipe()


def test_invalid_sender_identity_env_is_rejected(connect_cli: Any, monkeypatch: Any) -> None:
    monkeypatch.setenv("NATS_SENDER_IDENTITY", "maybe")
    parser = argparse.ArgumentParser()
    connect_cli.add_identity_flags(parser)
    with pytest.raises(SystemExit):
        parser.parse_args([])
