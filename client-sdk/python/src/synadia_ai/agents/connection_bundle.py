"""One-shot NATS connection authentication and optional sender signer.

The bundle resolver reads a context and its selected authentication source
exactly once.  Its connection options and optional signer therefore cannot
silently diverge if a credentials or nkey file changes between two reads.
The caller still owns the NATS connection and must call :meth:`wipe` only
after that connection has closed.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Generic, Literal, TypeAlias, TypeVar, overload

from .context import (
    _build_context_base_options,
    _extract_seed_line,
    expand_user,
    parse_nats_url,
    read_context_file,
)
from .errors import IdentityError, IdentityMismatchError, NatsContextError
from .identity.signer import NkeySigner, identity_from_jwt, signer_from_creds, signer_from_seed

IdentityMode: TypeAlias = Literal["off", "signed"]
CredentialSource: TypeAlias = str | Path
SignerT = TypeVar("SignerT", bound=NkeySigner | None)

_AUTH_OPTION_KEYS = (
    "nkeys_seed_str",
    "password",
    "signature_cb",
    "token",
    "user",
    "user_jwt_cb",
)
_JWT_CALLBACK_AUTH_PASSWORD_SENTINEL = "_synadia_jwt_callbacks_enabled"


class NatsConnectionBundle(Generic[SignerT]):
    """NATS connect kwargs paired with a signer from the same auth snapshot.

    ``connection_options`` necessarily contains authentication configuration;
    treat it as secret and never log it.  The custom representation exposes
    neither values nor option names.  :meth:`wipe` is idempotent and removes
    retained auth options plus any in-memory nkey signers.  Call it only after
    the NATS connection is closed, because reconnect authentication uses the
    captured material.
    """

    __slots__ = ("_owned_signers", "_wiped", "connection_options", "signer")

    connection_options: dict[str, Any]
    signer: SignerT
    _owned_signers: tuple[NkeySigner, ...]
    _wiped: bool

    def __init__(
        self,
        connection_options: dict[str, Any],
        signer: SignerT,
        *,
        owned_signers: tuple[NkeySigner, ...] = (),
    ) -> None:
        self.connection_options = connection_options
        self.signer = signer
        self._owned_signers = owned_signers
        self._wiped = False

    def wipe(self) -> None:
        """Clear retained auth material after the NATS connection is closed."""
        if self._wiped:
            return
        self._wiped = True
        try:
            for owned in self._owned_signers:
                owned.wipe()
        finally:
            # Do not leave live callbacks or auth values in the public
            # mapping even if a future/custom signer cleanup raises.
            for key in _AUTH_OPTION_KEYS:
                self.connection_options.pop(key, None)

    def __repr__(self) -> str:
        mode = "signed" if self.signer is not None else "off"
        return f"NatsConnectionBundle(identity={mode!r}, redacted=True, wiped={self._wiped})"

    __str__ = __repr__


@overload
def resolve_nats_connection_bundle(
    *,
    context: str | None = None,
    url: str | None = None,
    creds: CredentialSource | None = None,
    nkey: CredentialSource | None = None,
    identity: Literal["signed"],
) -> NatsConnectionBundle[NkeySigner]: ...


@overload
def resolve_nats_connection_bundle(
    *,
    context: str | None = None,
    url: str | None = None,
    creds: CredentialSource | None = None,
    nkey: CredentialSource | None = None,
    identity: Literal["off"] = "off",
) -> NatsConnectionBundle[None]: ...


@overload
def resolve_nats_connection_bundle(
    *,
    context: str | None = None,
    url: str | None = None,
    creds: CredentialSource | None = None,
    nkey: CredentialSource | None = None,
    identity: IdentityMode = "off",
) -> NatsConnectionBundle[NkeySigner | None]: ...


def resolve_nats_connection_bundle(
    *,
    context: str | None = None,
    url: str | None = None,
    creds: CredentialSource | None = None,
    nkey: CredentialSource | None = None,
    identity: IdentityMode = "off",
) -> NatsConnectionBundle[Any]:
    """Snapshot NATS auth once and optionally derive its sender signer.

    Select exactly one connection source: ``context=...`` or ``url=...``.
    URL mode may additionally select one connection credential source,
    either ``creds=...`` (a NATS ``.creds`` file) or ``nkey=...`` (a user
    seed file).  These are connection credentials, not a second
    identity-only path.

    ``identity="off"`` is the default and returns ``signer=None`` while
    preserving every supported connection-auth mode.  ``"signed"`` returns
    a signer only when the selected connection authentication contains a
    user seed; it fails instead of falling back for token, user/password,
    JWT-without-seed, or anonymous connections.
    """
    if identity not in ("off", "signed"):
        raise ValueError("identity must be 'off' or 'signed'")
    if (context is None) == (url is None):
        raise NatsContextError("select exactly one NATS source: `context` or `url`")
    if context is not None:
        if creds is not None or nkey is not None:
            raise NatsContextError(
                "`creds` and `nkey` are URL connection sources and cannot accompany `context`"
            )
        return _resolve_context(context, signed=identity == "signed")
    assert url is not None
    return _resolve_url(url, creds=creds, nkey=nkey, signed=identity == "signed")


def _resolve_context(selector: str, *, signed: bool) -> NatsConnectionBundle[NkeySigner | None]:
    ctx = read_context_file(selector)
    options = _build_context_base_options(ctx)
    fields = ctx.fields
    context_url = _nonempty_str(fields.get("url"))
    if context_url is None:  # defensive: already validated by _build_context_base_options
        raise NatsContextError(f"NATS context {selector!r} is missing `url`")
    parsed_url = parse_nats_url(context_url)
    options["servers"] = parsed_url["servers"]
    for key in ("token", "user", "password"):
        if key in parsed_url:
            options[key] = parsed_url[key]

    creds = _nonempty_str(fields.get("creds"))
    nkey = _nonempty_str(fields.get("nkey"))
    user_jwt = _nonempty_str(fields.get("user_jwt"))
    user_seed = _nonempty_str(fields.get("user_seed"))

    if creds is not None:
        _clear_basic_auth(options)
        signer = _signer_from_creds_path(creds, source=f"NATS context {ctx.name!r}")
        options.update(_creds_connection_options(signer))
        return _bundle_with_connection_signer(options, signer, signed=signed)

    if nkey is not None:
        _clear_basic_auth(options)
        seed = _read_nkey_path(nkey, source=f"NATS context {ctx.name!r}")
        return _nkey_bundle(options, seed, signed=signed)

    if user_jwt is not None:
        _clear_basic_auth(options)
        if user_seed is not None:
            signer = _signer_from_jwt_seed(user_jwt, user_seed)
            options.update(_creds_connection_options(signer))
            return _bundle_with_connection_signer(options, signer, signed=signed)

        options.update(_seedless_jwt_connection_options(user_jwt))
        if signed:
            raise IdentityError(
                f"NATS context {ctx.name!r} selected `user_jwt` without `user_seed`; "
                "signed identity requires the connection's user seed"
            )
        return NatsConnectionBundle(options, None)

    if any(_nonempty_str(fields.get(key)) is not None for key in ("user", "password", "token")):
        _clear_basic_auth(options)
        _apply_password_or_token(options, fields)
    if signed:
        raise IdentityError(_missing_seed_message(_auth_kind(options)))
    return NatsConnectionBundle(options, None)


def _resolve_url(
    url: str,
    *,
    creds: CredentialSource | None,
    nkey: CredentialSource | None,
    signed: bool,
) -> NatsConnectionBundle[NkeySigner | None]:
    if creds is not None and nkey is not None:
        raise NatsContextError("select at most one URL credential source: `creds` or `nkey`")

    options = parse_nats_url(url)
    if creds is not None or nkey is not None:
        # Match normal NATS option precedence: an explicit credential source
        # is authoritative over URL userinfo.  parse_nats_url has already
        # stripped that userinfo from every server URL, so remove its kwargs.
        for key in ("token", "user", "password"):
            options.pop(key, None)

    if creds is not None:
        signer = _signer_from_creds_path(creds, source="NATS URL")
        options.update(_creds_connection_options(signer))
        return _bundle_with_connection_signer(options, signer, signed=signed)

    if nkey is not None:
        seed = _read_nkey_path(nkey, source="NATS URL")
        return _nkey_bundle(options, seed, signed=signed)

    if signed:
        raise IdentityError(_missing_seed_message(_auth_kind(options)))
    return NatsConnectionBundle(options, None)


def _bundle_with_connection_signer(
    options: dict[str, Any], signer: NkeySigner, *, signed: bool
) -> NatsConnectionBundle[NkeySigner | None]:
    if signed:
        return NatsConnectionBundle(options, signer, owned_signers=(signer,))
    return NatsConnectionBundle(options, None, owned_signers=(signer,))


def _nkey_bundle(
    options: dict[str, Any], seed: str, *, signed: bool
) -> NatsConnectionBundle[NkeySigner | None]:
    # nats-py snapshots `nkeys_seed_str` on connect and derives its reconnect
    # callback from that string.  Passing a path would reread it; passing raw
    # block text or a trailing newline would fail nkeys decoding.
    options["nkeys_seed_str"] = seed
    if not signed:
        return NatsConnectionBundle(options, None)
    signer = signer_from_seed(seed)
    return NatsConnectionBundle(options, signer, owned_signers=(signer,))


def _creds_connection_options(signer: NkeySigner) -> dict[str, Any]:
    jwt = signer.jwt
    if jwt is None:  # pragma: no cover - internal invariant
        signer.wipe()
        raise IdentityError("credentials snapshot did not contain a user JWT")
    jwt_bytes = jwt.encode("utf-8")

    def user_jwt_cb() -> bytes:
        return jwt_bytes

    def signature_cb(nonce: str) -> bytes:
        return base64.b64encode(signer.sign(nonce.encode("utf-8")))

    # nats-py 2.x does not mark a connection as authenticated when only its
    # public `user_jwt_cb` / `signature_cb` options are supplied. A non-secret
    # password-only sentinel makes it enter the auth branch; with a nonce the
    # callback branch wins, while without a nonce nats-py sends neither `user`
    # nor `pass` because no user is configured. Do not use a token sentinel:
    # that would become a real fallback credential on a no-nonce server.
    # Verified against the declared minimum nats-py 2.7.0 and current 2.x;
    # the no-nonce CONNECT-shape regression test locks this assumption.
    return {
        "password": _JWT_CALLBACK_AUTH_PASSWORD_SENTINEL,
        "signature_cb": signature_cb,
        "user_jwt_cb": user_jwt_cb,
    }


def _seedless_jwt_connection_options(jwt: str) -> dict[str, Any]:
    """Captured callbacks for a bearer user JWT without a signing seed."""
    jwt_bytes = jwt.encode("utf-8")

    def user_jwt_cb() -> bytes:
        return jwt_bytes

    def empty_signature_cb(_nonce: str) -> bytes:
        # Mirrors the TypeScript jwtAuthenticator(jwt) shape. Bearer user
        # JWTs do not sign the server nonce, but nats-py emits `jwt` only
        # from its nonce callback branch.
        return b""

    return {
        "password": _JWT_CALLBACK_AUTH_PASSWORD_SENTINEL,
        "signature_cb": empty_signature_cb,
        "user_jwt_cb": user_jwt_cb,
    }


def _signer_from_creds_path(source_path: CredentialSource, *, source: str) -> NkeySigner:
    path = Path(expand_user(str(source_path)))
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise NatsContextError(
            f"{source}: failed to read creds file {path}: {exc.strerror}"
        ) from exc
    return signer_from_creds(text)


def _read_nkey_path(source_path: CredentialSource, *, source: str) -> str:
    path = Path(expand_user(str(source_path)))
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise NatsContextError(
            f"{source}: failed to read nkey seed file {path}: {exc.strerror}"
        ) from exc
    seed = _extract_seed_line(text)
    if seed is None:
        raise NatsContextError(f"{source}: no nkey seed line found in {path}")
    return seed


def _signer_from_jwt_seed(jwt: str, seed: str) -> NkeySigner:
    signer = signer_from_seed(seed, jwt)
    try:
        jwt_user = identity_from_jwt(jwt).user
        if jwt_user == signer.public_key:
            return signer
        raise IdentityMismatchError(
            signer.public_key,
            signer.public_key,
            credential_user=jwt_user,
        )
    except Exception:
        signer.wipe()
        raise


def _apply_password_or_token(options: dict[str, Any], fields: dict[str, Any]) -> None:
    user = _nonempty_str(fields.get("user"))
    password = _nonempty_str(fields.get("password"))
    if user is not None or password is not None:
        if user is not None:
            options["user"] = user
        if password is not None:
            options["password"] = password
        return
    token = _nonempty_str(fields.get("token"))
    if token is not None:
        options["token"] = token


def _clear_basic_auth(options: dict[str, Any]) -> None:
    for key in ("token", "user", "password"):
        options.pop(key, None)


def _auth_kind(options: dict[str, Any]) -> str:
    if "token" in options:
        return "token"
    if "user" in options or "password" in options:
        return "user/password"
    return "anonymous"


def _missing_seed_message(auth_kind: str) -> str:
    return (
        f"signed identity is unavailable for {auth_kind} NATS authentication; "
        "select connection credentials that contain the connection's user seed"
    )


def _nonempty_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


__all__ = [
    "CredentialSource",
    "IdentityMode",
    "NatsConnectionBundle",
    "resolve_nats_connection_bundle",
]
