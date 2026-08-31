"""Immutable NATS connection auth + optional signer bundles."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import nats
import pytest

from synadia_ai.agents import (
    Agents,
    Identity,
    IdentityError,
    NatsConnectionBundle,
    NatsContextError,
    parse_nats_url,
    resolve_nats_connection_bundle,
)
from synadia_ai.agents.identity import identity_from_jwt, parse_creds, verify_with_public_key
from tests.harness.nats_server import find_nats_server, identity_fixture, start_server

if TYPE_CHECKING:
    from tests.conftest import NkeyUser


def _write_context(root: Path, name: str, fields: dict[str, object]) -> Path:
    context_dir = root / "nats" / "context"
    context_dir.mkdir(parents=True, exist_ok=True)
    path = context_dir / f"{name}.json"
    path.write_text(json.dumps(fields), encoding="utf-8")
    return path


def _point_at_context_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NATS_CONFIG_HOME", raising=False)
    monkeypatch.delenv("NATS_CONTEXT", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))


def test_source_selection_and_identity_mode_are_explicit(tmp_path: Path) -> None:
    with pytest.raises(NatsContextError, match="exactly one"):
        resolve_nats_connection_bundle()
    with pytest.raises(NatsContextError, match="exactly one"):
        resolve_nats_connection_bundle(context="prod", url="nats://localhost:4222")
    with pytest.raises(NatsContextError, match="cannot accompany"):
        resolve_nats_connection_bundle(context="prod", creds=tmp_path / "user.creds")
    with pytest.raises(NatsContextError, match="at most one"):
        resolve_nats_connection_bundle(
            url="nats://localhost:4222",
            creds=tmp_path / "user.creds",
            nkey=tmp_path / "user.nk",
        )
    with pytest.raises(ValueError, match="'off' or 'signed'"):
        resolve_nats_connection_bundle(url="nats://localhost:4222", identity=cast(Any, "maybe"))


def test_identity_off_preserves_plain_auth_and_exposes_no_signer() -> None:
    token = "super-secret-token"
    password = "super-secret-password"
    token_bundle = resolve_nats_connection_bundle(url=f"nats://{token}@localhost:4222")
    password_bundle = resolve_nats_connection_bundle(url=f"nats://alice:{password}@localhost:4222")

    assert token_bundle.connection_options["token"] == token
    assert password_bundle.connection_options["user"] == "alice"
    assert password_bundle.connection_options["password"] == password
    assert token_bundle.signer is None and password_bundle.signer is None

    for bundle in (token_bundle, password_bundle):
        rendered = f"{bundle!r} {bundle!s}"
        assert rendered == (
            "NatsConnectionBundle(identity='off', redacted=True, wiped=False) "
            "NatsConnectionBundle(identity='off', redacted=True, wiped=False)"
        )
        for secret in (token, password, "alice", "token", "password", "connection_options"):
            assert secret not in rendered

    token_bundle.wipe()
    token_bundle.wipe()
    password_bundle.wipe()
    assert "token" not in token_bundle.connection_options
    assert "user" not in password_bundle.connection_options
    assert "password" not in password_bundle.connection_options


@pytest.mark.parametrize(
    "url, auth_kind",
    [
        ("nats://localhost:4222", "anonymous"),
        ("nats://token@localhost:4222", "token"),
        ("nats://user:pass@localhost:4222", "user/password"),
    ],
)
def test_signed_mode_never_falls_back_without_a_connection_seed(url: str, auth_kind: str) -> None:
    with pytest.raises(IdentityError, match=auth_kind):
        resolve_nats_connection_bundle(url=url, identity="signed")


def test_nkey_is_normalized_once_for_connection_and_signer(
    tmp_path: Path, identity_keys: dict[str, NkeyUser]
) -> None:
    alice = identity_keys["alice"]
    bob = identity_keys["bob"]
    nkey = tmp_path / "alice.nk"
    nkey.write_text(
        f"-----BEGIN USER NKEY SEED-----\n{alice.seed}\n------END USER NKEY SEED------\n",
        encoding="utf-8",
    )

    bundle = resolve_nats_connection_bundle(
        url="nats://localhost:4222", nkey=nkey, identity="signed"
    )
    nkey.write_text(f"{bob.seed}\n", encoding="utf-8")

    assert bundle.connection_options["nkeys_seed_str"] == alice.seed
    assert bundle.signer.public_key == alice.public
    rendered = repr(bundle)
    assert alice.seed not in rendered and str(nkey) not in rendered

    bundle.wipe()
    bundle.wipe()
    assert "nkeys_seed_str" not in bundle.connection_options
    with pytest.raises(IdentityError, match="wiped"):
        bundle.signer.sign(b"after-close")


def test_creds_snapshot_drives_callbacks_and_optional_public_signer(tmp_path: Path) -> None:
    alice_source = identity_fixture("operator/alice.creds")
    bob_source = identity_fixture("operator/bob.creds")
    creds = tmp_path / "current-user.creds"
    alice_text = alice_source.read_text(encoding="utf-8")
    creds.write_text(alice_text, encoding="utf-8")
    alice = parse_creds(alice_text)

    bundle = resolve_nats_connection_bundle(
        url="nats://url-token@localhost:4222", creds=creds, identity="signed"
    )
    creds.write_text(bob_source.read_text(encoding="utf-8"), encoding="utf-8")

    assert "user_credentials" not in bundle.connection_options
    assert "nkeys_seed_str" not in bundle.connection_options
    assert "token" not in bundle.connection_options
    assert "user" not in bundle.connection_options
    assert isinstance(bundle.connection_options["password"], str)
    assert bundle.signer.jwt == alice.jwt
    assert "url-token" not in bundle.connection_options.values()

    jwt_cb = cast(Callable[[], bytes], bundle.connection_options["user_jwt_cb"])
    signature_cb = cast(Callable[[str], bytes], bundle.connection_options["signature_cb"])
    assert jwt_cb().decode() == alice.jwt
    assert verify_with_public_key(
        bundle.signer.public_key,
        b"server-nonce",
        base64.b64decode(signature_cb("server-nonce")),
    )

    rendered = f"{bundle!r} {bundle!s}"
    for secret in (
        alice.jwt,
        alice.seed,
        str(creds),
        "url-token",
        "signature_cb",
        "user_jwt_cb",
    ):
        assert secret not in rendered

    bundle.wipe()
    with pytest.raises(IdentityError, match="wiped"):
        signature_cb("after-close")

    off = resolve_nats_connection_bundle(url="nats://localhost:4222", creds=bob_source)
    assert off.signer is None
    assert callable(off.connection_options["signature_cb"])
    off.wipe()


def test_context_and_selected_creds_are_each_read_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at_context_root(tmp_path, monkeypatch)
    creds = tmp_path / "home" / "alice.creds"
    creds.parent.mkdir(parents=True)
    creds.write_text(identity_fixture("operator/alice.creds").read_text(), encoding="utf-8")
    context = _write_context(
        tmp_path,
        "prod",
        {
            "url": "nats://url-context-secret@127.0.0.1:4222",
            "creds": str(creds),
            "token": "lower-priority-secret",
        },
    )

    original_read_text = Path.read_text
    reads: dict[Path, int] = {}

    def counted_read_text(path: Path, *args: Any, **kwargs: Any) -> str:
        reads[path] = reads.get(path, 0) + 1
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", counted_read_text)
    bundle = resolve_nats_connection_bundle(context="prod", identity="signed")

    assert reads[context] == 1
    assert reads[creds] == 1
    assert bundle.signer.jwt is not None
    assert "lower-priority-secret" not in bundle.connection_options.values()
    assert "url-context-secret" not in repr(bundle.connection_options["servers"])
    bundle.wipe()


def test_context_nkey_block_is_normalized_and_identity_off_stays_off(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    identity_keys: dict[str, NkeyUser],
) -> None:
    _point_at_context_root(tmp_path, monkeypatch)
    alice = identity_keys["alice"]
    nkey = tmp_path / "home" / "alice.nk"
    nkey.parent.mkdir(parents=True)
    nkey.write_text(
        f"-----BEGIN USER NKEY SEED-----\n{alice.seed}\n------END USER NKEY SEED------\n",
        encoding="utf-8",
    )
    _write_context(
        tmp_path,
        "nkey",
        {"url": "nats://127.0.0.1:4222", "nkey": "~/alice.nk"},
    )

    off = resolve_nats_connection_bundle(context="nkey")
    assert off.connection_options["nkeys_seed_str"] == alice.seed
    assert off.signer is None
    signed = resolve_nats_connection_bundle(context="nkey", identity="signed")
    assert signed.connection_options["nkeys_seed_str"] == alice.seed
    assert signed.signer.public_key == alice.public
    off.wipe()
    signed.wipe()


def test_context_token_and_jwt_without_seed_reject_signed_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at_context_root(tmp_path, monkeypatch)
    _write_context(
        tmp_path,
        "token",
        {"url": "nats://127.0.0.1:4222", "token": "secret-token"},
    )
    _write_context(
        tmp_path,
        "jwt",
        {"url": "nats://127.0.0.1:4222", "user_jwt": "header.payload.signature"},
    )

    with pytest.raises(IdentityError, match="token"):
        resolve_nats_connection_bundle(context="token", identity="signed")
    with pytest.raises(IdentityError, match="without `user_seed`"):
        resolve_nats_connection_bundle(context="jwt", identity="signed")

    token_off = resolve_nats_connection_bundle(context="token")
    jwt_off = resolve_nats_connection_bundle(context="jwt")
    assert token_off.connection_options["token"] == "secret-token"
    jwt_cb = cast(Callable[[], bytes], jwt_off.connection_options["user_jwt_cb"])
    signature_cb = cast(Callable[[str], bytes], jwt_off.connection_options["signature_cb"])
    assert jwt_cb() == b"header.payload.signature"
    assert signature_cb("server-nonce") == b""
    assert "token" not in jwt_off.connection_options
    assert "user" not in jwt_off.connection_options
    assert isinstance(jwt_off.connection_options["password"], str)

    assert token_off.signer is None and jwt_off.signer is None
    token_off.wipe()
    jwt_off.wipe()
    assert "password" not in jwt_off.connection_options


async def test_jwt_callback_sentinel_is_never_sent_without_a_server_nonce() -> None:
    connect_line: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writer.write(
            b'INFO {"server_id":"test","server_name":"test","version":"2.12.7",'
            b'"proto":1,"host":"127.0.0.1","port":4222,"headers":true,'
            b'"max_payload":1048576}\r\n'
        )
        await writer.drain()
        try:
            while line := await reader.readline():
                if line.startswith(b"CONNECT ") and not connect_line.done():
                    connect_line.set_result(line)
                elif line == b"PING\r\n":
                    writer.write(b"PONG\r\n")
                    await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle_client, "127.0.0.1", 0)
    socket = server.sockets[0]
    port = socket.getsockname()[1]
    bundle = resolve_nats_connection_bundle(
        url=f"nats://127.0.0.1:{port}",
        creds=identity_fixture("operator/alice.creds"),
    )
    nc = None
    try:
        nc = await nats.connect(
            **bundle.connection_options,
            allow_reconnect=False,
            connect_timeout=1,
        )
        wire = await asyncio.wait_for(connect_line, timeout=1)
        payload = json.loads(wire.removeprefix(b"CONNECT ").strip())
        for field in ("auth_token", "jwt", "pass", "sig", "user"):
            assert field not in payload
    finally:
        if nc is not None:
            await nc.close()
        server.close()
        await server.wait_closed()
        bundle.wipe()


def test_context_inline_jwt_and_seed_share_one_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _point_at_context_root(tmp_path, monkeypatch)
    parsed = parse_creds(identity_fixture("operator/alice.creds").read_text(encoding="utf-8"))
    _write_context(
        tmp_path,
        "inline",
        {
            "url": "nats://127.0.0.1:4222",
            "user_jwt": parsed.jwt,
            "user_seed": parsed.seed,
        },
    )

    bundle = resolve_nats_connection_bundle(context="inline", identity="signed")
    jwt_cb = cast(Callable[[], bytes], bundle.connection_options["user_jwt_cb"])
    assert jwt_cb().decode() == parsed.jwt
    assert bundle.signer.jwt == parsed.jwt
    assert bundle.signer.public_key == identity_from_jwt(jwt_cb().decode()).user
    bundle.wipe()


@pytest.mark.parametrize(
    "url",
    [
        "nats://first-secret@one:4222,nats://second-secret@two:4222",
        "http://scheme-secret@localhost:4222",
        "nats://missing-host-secret@",
    ],
)
def test_url_errors_redact_userinfo(url: str) -> None:
    with pytest.raises((NatsContextError, ValueError)) as exc_info:
        parse_nats_url(url)
    message = str(exc_info.value)
    assert "first-secret" not in message
    assert "second-secret" not in message
    assert "scheme-secret" not in message
    assert "missing-host-secret" not in message


def test_websocket_paths_and_queries_survive_direct_and_context_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    direct = resolve_nats_connection_bundle(
        url="wss://direct-token@ws.example.test/nats?tenant=direct"
    )
    assert direct.connection_options["servers"] == ["wss://ws.example.test/nats?tenant=direct"]
    assert direct.connection_options["token"] == "direct-token"

    _point_at_context_root(tmp_path, monkeypatch)
    _write_context(
        tmp_path,
        "websocket",
        {"url": "ws://context-token@ws.example.test:9222/nats?tenant=context"},
    )
    context = resolve_nats_connection_bundle(context="websocket")
    assert context.connection_options["servers"] == [
        "ws://ws.example.test:9222/nats?tenant=context"
    ]
    assert context.connection_options["token"] == "context-token"
    direct.wipe()
    context.wipe()


async def test_creds_callbacks_survive_file_rotation_and_real_reconnect(tmp_path: Path) -> None:
    if find_nats_server() is None:
        pytest.skip("nats-server not on PATH — connection-bundle reconnect test skipped")

    log_dir = tmp_path / "logs"
    config = identity_fixture("operator/operator.conf")
    first = start_server(log_dir, config_path=config)
    try:
        second = start_server(log_dir, config_path=config)
        try:
            creds = tmp_path / "alice.creds"
            creds.write_text(
                identity_fixture("operator/alice.creds").read_text(encoding="utf-8"),
                encoding="utf-8",
            )
            bundle = resolve_nats_connection_bundle(
                url=f"{first.url},{second.url}", creds=creds, identity="signed"
            )
            reconnected = asyncio.Event()

            async def reconnected_cb() -> None:
                reconnected.set()

            options = {
                **bundle.connection_options,
                "dont_randomize": True,
                "max_reconnect_attempts": 50,
                "reconnect_time_wait": 0.05,
                "reconnected_cb": reconnected_cb,
            }
            nc = await nats.connect(**options)
            try:
                connected_url = nc.connected_url
                assert connected_url is not None and connected_url.port == first.port
                agents = Agents(nc=nc, identity=Identity(signer=bundle.signer))
                try:
                    assert (await agents.self_id()).user == bundle.signer.public_key
                    creds.write_text("rotated-invalid-creds", encoding="utf-8")
                    first.stop()
                    await asyncio.wait_for(reconnected.wait(), timeout=10)
                    connected_url = nc.connected_url
                    assert connected_url is not None and connected_url.port == second.port
                    await nc.flush()
                finally:
                    await agents.close()
            finally:
                await nc.close()
                bundle.wipe()
            with pytest.raises(IdentityError, match="wiped"):
                bundle.signer.sign(b"after-close")
        finally:
            second.stop()
    finally:
        first.stop()


def test_public_bundle_type_is_exported() -> None:
    bundle = resolve_nats_connection_bundle(url="nats://localhost:4222")
    assert isinstance(bundle, NatsConnectionBundle)
