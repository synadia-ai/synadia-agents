"""NATS connection factory with three variants: direct URL, CLI context, or passthrough.

:func:`connect` is the blessed way for agent authors and callers to open
(or reuse) a :class:`~nats.aio.client.Client`. It mirrors the TypeScript
SDK's ``connect()``/``attach()`` pair field-for-field so the two SDKs
behave identically when pointed at the same broker — same context file
layout, same auth precedence, same unsupported-field failures.

Scope for v0.1 (matches ``nats-ai-tssdk`` v0.1.0):

* ``url`` → ``servers`` (comma-separated strings split)
* ``token`` → ``token=``
* ``user`` / ``password`` → ``user=`` / ``password=``
* ``creds`` → ``user_credentials=<path>`` (``~`` expansion)
* ``user_jwt`` → ``user_jwt_cb`` callback returning JWT bytes
* ``inbox_prefix`` → ``inbox_prefix=``
* ``description`` → surfaced on :class:`NatsContext`

Deferred (raises :class:`~natsagent.errors.ContextNotSupportedError` when
present in a loaded context): ``nkey``, TLS triple (``cert`` / ``key`` /
``ca``), ``nsc://...`` URLs.

Ignored (present in JSON but irrelevant to the SDK): ``jetstream_*``,
``socks_proxy``, ``color_scheme``, ``windows_*``, ``user_seed`` (only
meaningful with ``nkey``), ``tls_first``.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import nats

from .errors import (
    ContextInvalidError,
    ContextNotFoundError,
    ContextNotSelectedError,
    ContextNotSupportedError,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


@dataclass(frozen=True)
class NatsContext:
    """A fully-resolved NATS context ready to pass to :func:`nats.connect`.

    Populated by :func:`_load_context` when ``connect(context=...)`` is
    called; surfaced for programmatic inspection but not part of the public
    import surface beyond the module-level re-export.
    """

    name: str
    servers: list[str]
    connection_kwargs: dict[str, Any] = field(default_factory=dict)
    description: str | None = None


# Supported context-file fields. Everything outside this set is either
# deferred (unsupported) or silently ignored — see module docstring.
_SUPPORTED_FIELDS = frozenset(
    {
        "description",
        "url",
        "token",
        "user",
        "password",
        "creds",
        "user_jwt",
        "inbox_prefix",
    }
)

# Fields we know about but do not yet wire to nats-py. Presence of any of
# these in a loaded context raises ContextNotSupportedError with an
# actionable message — we do NOT silently ignore.
_UNSUPPORTED_FIELDS = ("nkey", "cert", "key", "ca", "nsc")

# Fields we explicitly ignore (present in the JSON but irrelevant to the
# SDK). Listed here so reviewers can see the allow-list rather than
# guessing what falls through.
_IGNORED_FIELDS = frozenset(
    {
        "jetstream_domain",
        "jetstream_api_prefix",
        "jetstream_event_prefix",
        "socks_proxy",
        "color_scheme",
        "windows_cert_store",
        "windows_cert_match",
        "windows_cert_match_by",
        "user_seed",  # meaningful only paired with `nkey`
        "tls_first",
        "ns",  # used by `nats context` for internal bookkeeping
    }
)


async def connect(
    *,
    servers: str | list[str] | None = None,
    context: str | bool | None = None,
    nc: NATSClient | None = None,
    **nats_kwargs: Any,
) -> NATSClient:
    """Open (or pass through) a :class:`~nats.aio.client.Client`.

    Exactly one of three variants is required:

    1. ``servers=`` — direct URL(s). Composes with ``context=``; the
       explicit ``servers`` wins when both are present.
    2. ``context=`` — load from ``<nats-config-home>/context/<name>.json``.
       Pass ``True`` or ``"current"`` to honour ``$NATS_CONTEXT`` → the
       selection file written by ``nats context select``.
    3. ``nc=`` — caller-owned :class:`~nats.aio.client.Client`; returned
       as-is. Exclusive: passing ``nc=`` with any of ``servers`` /
       ``context`` / extra kwargs raises :class:`ValueError`.

    Variants 1 and 2: additional ``**nats_kwargs`` shallow-merge *over*
    any context-derived kwargs, so callers can override one field (say
    ``max_reconnect_attempts``) without re-specifying the auth bundle.
    """
    if nc is not None:
        if servers is not None or context is not None or nats_kwargs:
            raise ValueError(
                "connect(nc=...) is exclusive with servers=/context=/**kwargs — "
                "the passed connection is returned as-is"
            )
        return nc

    if servers is None and context is None:
        raise ValueError("connect(): one of servers=, context=, or nc= must be provided")

    context_kwargs: dict[str, Any] = {}
    context_servers: list[str] | None = None
    if context is not None:
        name = _resolve_current_context_name() if context in (True, "current") else context
        assert isinstance(name, str)
        ctx = _load_context(name)
        context_servers = list(ctx.servers)
        context_kwargs = dict(ctx.connection_kwargs)

    resolved_servers: str | list[str]
    if servers is not None:
        resolved_servers = servers
    else:
        assert context_servers is not None  # guarded above
        resolved_servers = context_servers

    merged: dict[str, Any] = {**context_kwargs, **nats_kwargs}
    return await nats.connect(resolved_servers, **merged)


# --- internals ----------------------------------------------------------


def _nats_config_dir() -> Path:
    """Resolve the `nats` CLI config dir, honouring the same env priority.

    Priority (matches ``natscli``):

    1. ``$NATS_CONFIG_HOME``
    2. ``$XDG_CONFIG_HOME/nats``
    3. ``$HOME/.config/nats``
    """
    override = os.environ.get("NATS_CONFIG_HOME")
    if override:
        return Path(override)
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "nats"
    home = os.environ.get("HOME")
    if home:
        return Path(home) / ".config" / "nats"
    raise ContextInvalidError(
        "?",
        "cannot resolve NATS config directory: set $NATS_CONFIG_HOME, $XDG_CONFIG_HOME, or $HOME",
    )


def _context_dir() -> Path:
    return _nats_config_dir() / "context"


def _selection_file() -> Path:
    return _nats_config_dir() / "context.txt"


def _assert_valid_context_name(name: str) -> None:
    """Reject names that would escape the context directory.

    The `nats` CLI only produces names matching ``^[a-zA-Z0-9._-]+$``; we
    tolerate the same plus a little slack for forward compat, but always
    reject separators, ``..``, and leading ``.``.
    """
    if not isinstance(name, str) or not name:
        raise ContextInvalidError(name or "", "context name must be a non-empty string")
    if "/" in name or "\\" in name or name == ".." or ".." in name.replace("\\", "/").split("/"):
        raise ContextInvalidError(name, f"context name {name!r} contains illegal characters")
    if name.startswith("."):
        raise ContextInvalidError(name, f"context name {name!r} must not start with '.'")


def _resolve_current_context_name() -> str:
    """Resolve ``context=True`` / ``context="current"`` to a concrete name.

    ``$NATS_CONTEXT`` wins; otherwise read the selection file written by
    ``nats context select``. Missing both raises
    :class:`ContextNotSelectedError`.
    """
    env_name = os.environ.get("NATS_CONTEXT")
    if env_name:
        return env_name
    selection = _selection_file()
    try:
        selected = selection.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise ContextNotSelectedError(str(selection)) from exc
    if not selected:
        raise ContextNotSelectedError(str(selection))
    return selected


def _split_urls(url: str) -> list[str]:
    """Split the context's ``url`` field into individual server URLs.

    Matches TS SDK ``splitUrls``: comma-separated, whitespace-trimmed,
    empty entries dropped.
    """
    return [part.strip() for part in url.split(",") if part.strip()]


def _load_context(name: str) -> NatsContext:
    """Load and parse ``<context-dir>/<name>.json`` into a :class:`NatsContext`."""
    _assert_valid_context_name(name)
    path = _context_dir() / f"{name}.json"
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise ContextNotFoundError(name, str(path)) from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ContextInvalidError(name, f"context file is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ContextInvalidError(name, "context file must be a JSON object")

    url = parsed.get("url")
    if not url or not isinstance(url, str):
        raise ContextInvalidError(name, "`url` field is required but missing/empty")
    servers = _split_urls(url)
    if not servers:
        raise ContextInvalidError(name, "`url` field resolved to zero servers")

    # Surface nsc:// with a pointed message — the field is valid JSON but
    # we can't resolve it without shelling out to `nsc`.
    if any(s.startswith("nsc://") for s in servers):
        raise ContextNotSupportedError(name, "nsc")

    for unsupported in _UNSUPPORTED_FIELDS:
        if parsed.get(unsupported):
            raise ContextNotSupportedError(name, unsupported)

    kwargs = _build_connection_kwargs(name, parsed)
    description = parsed.get("description") if isinstance(parsed.get("description"), str) else None

    return NatsContext(
        name=name,
        servers=servers,
        connection_kwargs=kwargs,
        description=description,
    )


def _build_connection_kwargs(name: str, parsed: dict[str, Any]) -> dict[str, Any]:
    """Translate a parsed context-file dict into nats-py connect() kwargs.

    Authenticator precedence (matches TS ``buildAuthenticator``):

    * ``creds`` supersedes ``user_jwt``
    * both supersede inline ``token`` / ``user`` + ``password``

    Empty strings are treated as unset.
    """
    out: dict[str, Any] = {}

    # Creds file beats everything else.
    creds = parsed.get("creds")
    if isinstance(creds, str) and creds:
        creds_path = _expand_user(creds)
        if not Path(creds_path).is_file():
            raise ContextInvalidError(name, f"creds file not found: {creds_path}")
        out["user_credentials"] = creds_path
        return _finalize_kwargs(out, parsed)

    # user_jwt string → a JWT callback returning the raw bytes.
    user_jwt = parsed.get("user_jwt")
    if isinstance(user_jwt, str) and user_jwt:
        jwt_bytes = user_jwt.encode("utf-8")

        def _jwt_cb() -> bytes:
            return jwt_bytes

        out["user_jwt_cb"] = _jwt_cb
        return _finalize_kwargs(out, parsed)

    # Fall back to inline auth primitives.
    token = parsed.get("token")
    if isinstance(token, str) and token:
        out["token"] = token
    user = parsed.get("user")
    if isinstance(user, str) and user:
        out["user"] = user
    password = parsed.get("password")
    if isinstance(password, str) and password:
        out["password"] = password

    return _finalize_kwargs(out, parsed)


def _finalize_kwargs(out: dict[str, Any], parsed: dict[str, Any]) -> dict[str, Any]:
    """Apply non-auth optional fields (inbox_prefix) to the kwargs dict."""
    inbox_prefix = parsed.get("inbox_prefix")
    if isinstance(inbox_prefix, str) and inbox_prefix:
        out["inbox_prefix"] = inbox_prefix.encode("utf-8")
    return out


def _expand_user(path: str) -> str:
    """Expand a leading ``~`` using ``$HOME`` (mirrors TS ``expandTilde``)."""
    if not path.startswith("~"):
        return path
    home = os.environ.get("HOME")
    if not home:
        return path
    if path == "~":
        return home
    if path.startswith("~/") or path.startswith("~\\"):
        return str(Path(home) / path[2:])
    return path


__all__ = [
    "NatsContext",
    "connect",
]
