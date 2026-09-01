"""Signers: seed / creds / JWT parsing, redaction, wipe, and ``signer_from_context`` (unit)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

import nkeys
import pytest

from synadia_ai.agents import (
    IdentityError,
    IdentityMismatchError,
    IdentityUnavailableError,
    NatsContextError,
    signer_from_context,
    signer_from_creds,
    signer_from_creds_file,
    signer_from_seed,
)
from synadia_ai.agents.identity import (
    base64url_encode,
    decode_jwt_payload,
    identity_from_jwt,
    parse_creds,
    verify_with_public_key,
)

if TYPE_CHECKING:
    from tests.conftest import NkeyUser

ACCOUNT_A = "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRL"


def fake_jwt(payload: dict[str, object]) -> str:
    """A user JWT with the given claims (unsigned third part — the SDK only reads it)."""

    def b64(o: object) -> str:
        return base64url_encode(json.dumps(o, separators=(",", ":")).encode())

    return (
        f"{b64({'typ': 'JWT', 'alg': 'ed25519-nkey'})}.{b64(payload)}.{base64url_encode(bytes(64))}"
    )


def creds_text(jwt: str, seed: str) -> str:
    return "\n".join(
        [
            "-----BEGIN NATS USER JWT-----",
            jwt,
            "------END NATS USER JWT------",
            "",
            "************************* IMPORTANT *************************",
            "NKEY Seed printed below can be used to sign and prove identity.",
            "",
            "-----BEGIN USER NKEY SEED-----",
            seed,
            "------END USER NKEY SEED------",
            "",
            "*************************************************************",
            "",
        ]
    )


def _point_env_at(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("NATS_CONFIG_HOME", raising=False)
    monkeypatch.delenv("NATS_CONTEXT", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    base = tmp_path / "nats"
    (base / "context").mkdir(parents=True, exist_ok=True)
    return base


def test_signer_from_seed_derives_signs_and_tolerates_whitespace_and_block(
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice = identity_keys["alice"]
    s = signer_from_seed(f"  {alice.seed}\n")
    assert s.public_key == alice.public
    assert s.jwt is None
    sig = s.sign(b"hello")
    assert verify_with_public_key(alice.public, b"hello", sig)
    assert signer_from_seed(alice.seed.encode()).public_key == alice.public
    block = f"-----BEGIN USER NKEY SEED-----\n{alice.seed}\n------END USER NKEY SEED------\n"
    assert signer_from_seed(block).public_key == alice.public


def test_signer_from_seed_rejects_without_echoing(identity_keys: dict[str, NkeyUser]) -> None:
    alice = identity_keys["alice"]
    account_seed = nkeys.encode_seed(bytes(32), nkeys.PREFIX_BYTE_ACCOUNT).decode()
    bad_crc = alice.seed[:-1] + ("A" if alice.seed[-1] != "A" else "B")
    for bad in (account_seed, "garbage", alice.public, alice.seed[:40] + "AAAA", bad_crc):
        with pytest.raises(IdentityError) as exc_info:
            signer_from_seed(bad)
        assert bad not in str(exc_info.value)


def test_signer_redacts_and_wipes(identity_keys: dict[str, NkeyUser]) -> None:
    alice = identity_keys["alice"]
    s = signer_from_seed(alice.seed)
    assert repr(s) == f"SenderSigner({alice.public})"
    assert str(s) == f"SenderSigner({alice.public})"
    assert alice.seed not in repr(s)
    s.wipe()
    with pytest.raises(IdentityError, match="wiped"):
        s.sign(b"x")
    s.wipe()  # idempotent
    assert s.public_key == alice.public  # cached; the seed is gone


def test_signer_wipe_drops_credentials_jwt(identity_keys: dict[str, NkeyUser]) -> None:
    alice = identity_keys["alice"]
    jwt = fake_jwt({"sub": alice.public, "iss": ACCOUNT_A})
    signer = signer_from_creds(creds_text(jwt, alice.seed))
    assert signer.jwt == jwt
    signer.wipe()
    assert signer.jwt is None
    with pytest.raises(IdentityError, match="wiped"):
        signer.sign(b"x")


def test_parse_creds_and_jwt(identity_keys: dict[str, NkeyUser]) -> None:
    alice = identity_keys["alice"]
    jwt = fake_jwt({"sub": alice.public, "iss": ACCOUNT_A, "nats": {"type": "user"}})
    parsed = parse_creds(creds_text(jwt, alice.seed))
    assert parsed.jwt == jwt and parsed.seed == alice.seed
    with pytest.raises(IdentityError, match="no -----BEGIN NATS USER JWT----- block"):
        parse_creds("nothing here")
    with pytest.raises(IdentityError, match="empty NATS USER JWT block at line 1"):
        parse_creds("-----BEGIN NATS USER JWT-----\n------END NATS USER JWT------\n")
    with pytest.raises(IdentityError, match="USER NKEY SEED"):
        parse_creds(f"-----BEGIN NATS USER JWT-----\n{jwt}\n------END NATS USER JWT------\n")
    with pytest.raises(IdentityError, match="not a JWT"):
        parse_creds(creds_text("not a jwt!", alice.seed))

    assert decode_jwt_payload(jwt)["sub"] == alice.public
    id = identity_from_jwt(jwt)
    assert id.user == alice.public and id.account == ACCOUNT_A
    via_signing_key = fake_jwt(
        {"sub": alice.public, "iss": "ASIGNINGKEY", "nats": {"issuer_account": ACCOUNT_A}}
    )
    assert identity_from_jwt(via_signing_key).account == ACCOUNT_A
    with pytest.raises(IdentityError, match="three parts"):
        identity_from_jwt("a.b")
    with pytest.raises(IdentityError, match="base64url-encoded JSON"):
        identity_from_jwt("a.!!!.c")
    with pytest.raises(IdentityUnavailableError, match="lacks"):
        identity_from_jwt(fake_jwt({"iss": "x"}))
    with pytest.raises(IdentityUnavailableError, match="usable"):
        identity_from_jwt(fake_jwt({"sub": "notakey", "iss": ACCOUNT_A}))


def test_signer_from_creds_carries_jwt_and_checks_the_seed(
    identity_keys: dict[str, NkeyUser],
) -> None:
    alice, bob = identity_keys["alice"], identity_keys["bob"]
    jwt = fake_jwt({"sub": alice.public, "iss": ACCOUNT_A})
    s = signer_from_creds(creds_text(jwt, alice.seed))
    assert s.jwt == jwt and s.public_key == alice.public
    with pytest.raises(IdentityMismatchError) as exc_info:
        signer_from_creds(creds_text(jwt, bob.seed))
    assert bob.seed not in str(exc_info.value)
    assert bob.public in str(exc_info.value)


def test_signer_from_creds_file_and_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, identity_keys: dict[str, NkeyUser]
) -> None:
    alice = identity_keys["alice"]
    base = _point_env_at(tmp_path, monkeypatch)
    home = tmp_path / "home"
    home.mkdir()
    jwt = fake_jwt({"sub": alice.public, "iss": ACCOUNT_A})
    creds = home / "user.creds"
    creds.write_text(creds_text(jwt, alice.seed), encoding="utf-8")
    assert signer_from_creds_file("~/user.creds").jwt == jwt
    with pytest.raises(IdentityError, match="failed to read creds file"):
        signer_from_creds_file(tmp_path / "missing.creds")

    seed_file = home / "user.nk"
    seed_file.write_text(alice.seed + "\n", encoding="utf-8")

    def ctx(name: str, body: dict[str, object]) -> None:
        (base / "context" / f"{name}.json").write_text(json.dumps(body), encoding="utf-8")

    ctx("creds", {"url": "nats://x:4222", "creds": "~/user.creds", "nkey": str(seed_file)})
    ctx("nkey", {"url": "nats://x:4222", "nkey": "~/user.nk"})
    ctx("inline", {"url": "nats://x:4222", "user_seed": alice.seed, "user_jwt": jwt})
    ctx(
        "inline-mismatch",
        {"url": "nats://x:4222", "user_seed": identity_keys["bob"].seed, "user_jwt": jwt},
    )
    ctx("none", {"url": "nats://x:4222", "user": "u", "password": "p"})
    ctx("missing-nkey", {"url": "nats://x:4222", "nkey": str(tmp_path / "nope.nk")})

    assert signer_from_context("creds").jwt == jwt  # creds wins over nkey
    nk = signer_from_context("nkey")
    assert nk.public_key == alice.public and nk.jwt is None
    assert signer_from_context("inline").jwt == jwt
    with pytest.raises(IdentityMismatchError):
        signer_from_context("inline-mismatch")
    with pytest.raises(IdentityError, match="nothing to sign"):
        signer_from_context("none")
    with pytest.raises(IdentityError, match="failed to read nkey seed file"):
        signer_from_context("missing-nkey")
    with pytest.raises(NatsContextError):
        signer_from_context("ghost")
    monkeypatch.setenv("NATS_CONTEXT", "nkey")
    assert signer_from_context("current").public_key == alice.public
