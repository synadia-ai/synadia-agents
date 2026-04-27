"""``nats`` CLI context loader for callers that own their NATS connection.

:func:`load_context_options` reads context files written by ``nats context
add`` / ``nats context select`` under ``~/.config/nats`` (or
``$NATS_CONFIG_HOME`` / ``$XDG_CONFIG_HOME/nats``) and translates them
into kwargs ready to splat into :func:`nats.connect`::

    import nats
    from synadia_ai.agents import Agents, load_context_options

    nc = await nats.connect(**load_context_options("prod"))
    agents = Agents(nc=nc)

Mirrors the TS SDK's ``loadContextOptions`` (PR #7 follow-up) — same
context-file layout, same auth precedence, same unsupported-field
failures. The SDK itself does NOT open NATS connections; the caller
owns ``nc`` and is responsible for closing it.

Supports: ``url``, ``token``, ``user``/``password``, ``creds`` (with
``~`` expansion), ``user_jwt``, ``inbox_prefix``.

Auth precedence: ``creds`` > ``user_jwt`` > inline ``token`` /
``user``+``password``.

Unsupported fields raise :class:`~synadia_ai.agents.errors.NatsContextError`
with an actionable message: ``nkey``, TLS triple (``cert`` / ``key`` /
``ca``), ``nsc://...`` URLs.

Ignored (present in JSON but irrelevant to the SDK): ``jetstream_*``,
``socks_proxy``, ``color_scheme``, ``windows_*``, ``user_seed`` (only
meaningful with ``nkey``), ``tls_first``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .errors import NatsContextError

# Fields we know about but do not yet wire into connect kwargs. Presence
# of any of these in a loaded context raises NatsContextError — we do
# NOT silently ignore.
_UNSUPPORTED_FIELDS = ("nkey", "cert", "key", "ca", "nsc")


def load_context_options(selector: str) -> dict[str, Any]:
    """Resolve a ``nats`` CLI context into kwargs for :func:`nats.connect`.

    Pass ``"current"`` to honour ``$NATS_CONTEXT`` → the selection file
    written by ``nats context select``. Any other value loads
    ``<config-dir>/context/<selector>.json`` directly.

    Returns a dict with at minimum ``servers``; auth kwargs (``token``,
    ``user``, ``password``, ``user_credentials``, ``user_jwt_cb``) and
    ``inbox_prefix`` are added when the context declared them.

    Raises :class:`~synadia_ai.agents.errors.NatsContextError` on any failure:
    missing file, malformed JSON, illegal name, missing ``url``,
    unsupported field, missing ``creds`` file, no context selected.
    """
    name = _resolve_current_context_name() if selector == "current" else selector
    _assert_valid_context_name(name)

    path = _context_dir() / f"{name}.json"
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise NatsContextError(
            f"NATS context {name!r} not found at {path} — try `nats context ls` "
            f"to see which contexts exist, or `nats context add {name} --server=...` "
            "to create one"
        ) from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise NatsContextError(f"NATS context {name!r} is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise NatsContextError(f"NATS context {name!r} must be a JSON object")

    url = parsed.get("url")
    if not isinstance(url, str) or not url:
        raise NatsContextError(f"NATS context {name!r} is missing `url` (or it is empty)")
    servers = _split_urls(url)
    if not servers:
        raise NatsContextError(f"NATS context {name!r}: `url` field resolved to zero servers")

    if any(s.startswith("nsc://") for s in servers):
        raise NatsContextError(
            f"NATS context {name!r}: `nsc://` URLs require shelling out to "
            "`nsc` and are not yet supported"
        )

    for unsupported in _UNSUPPORTED_FIELDS:
        if parsed.get(unsupported):
            raise NatsContextError(
                f"NATS context {name!r}: `{unsupported}` is not yet supported in "
                "synadia-ai-agents; use `creds` / a credentials file if possible, or open "
                "an issue at https://github.com/synadia-ai/synadia-agents/issues"
            )

    out: dict[str, Any] = {"servers": servers}
    out.update(_build_auth_kwargs(name, parsed))

    inbox_prefix = parsed.get("inbox_prefix")
    if isinstance(inbox_prefix, str) and inbox_prefix:
        out["inbox_prefix"] = inbox_prefix

    return out


def _build_auth_kwargs(name: str, parsed: dict[str, Any]) -> dict[str, Any]:
    """Pick the right auth kwargs given the context's auth precedence.

    Precedence: ``creds`` > ``user_jwt`` > inline ``token`` /
    ``user``+``password``. Empty strings are treated as unset so a
    context with one slot zeroed out doesn't shadow another.
    """
    out: dict[str, Any] = {}

    creds = parsed.get("creds")
    if isinstance(creds, str) and creds:
        creds_path = _expand_user(creds)
        if not Path(creds_path).is_file():
            raise NatsContextError(f"NATS context {name!r}: creds file not found: {creds_path}")
        out["user_credentials"] = creds_path
        return out

    user_jwt = parsed.get("user_jwt")
    if isinstance(user_jwt, str) and user_jwt:
        jwt_bytes = user_jwt.encode("utf-8")

        def _jwt_cb() -> bytes:
            return jwt_bytes

        out["user_jwt_cb"] = _jwt_cb
        return out

    for key in ("token", "user", "password"):
        value = parsed.get(key)
        if isinstance(value, str) and value:
            out[key] = value
    return out


# --- internals ----------------------------------------------------------


def _nats_config_dir() -> Path:
    """Resolve the `nats` CLI config dir, honouring the same env priority.

    Priority (matches ``natscli``): ``$NATS_CONFIG_HOME``, then
    ``$XDG_CONFIG_HOME/nats``, then ``$HOME/.config/nats``.
    """
    override = os.environ.get("NATS_CONFIG_HOME")
    if override:
        return Path(_expand_user(override))
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "nats"
    home = os.environ.get("HOME")
    if home:
        return Path(home) / ".config" / "nats"
    raise NatsContextError(
        "cannot resolve NATS config directory: set $NATS_CONFIG_HOME, $XDG_CONFIG_HOME, or $HOME"
    )


def _context_dir() -> Path:
    return _nats_config_dir() / "context"


def _selection_file() -> Path:
    return _nats_config_dir() / "context.txt"


def _assert_valid_context_name(name: str) -> None:
    """Reject names that would escape the context directory."""
    if not isinstance(name, str) or not name:
        raise NatsContextError("context name must be a non-empty string")
    if "\x00" in name:
        raise NatsContextError(f"context name {name!r} contains a NUL byte")
    if "/" in name or "\\" in name or name == ".." or ".." in name.replace("\\", "/").split("/"):
        raise NatsContextError(f"context name {name!r} contains illegal characters")
    if name.startswith("."):
        raise NatsContextError(f"context name {name!r} must not start with '.'")


def _resolve_current_context_name() -> str:
    """Resolve ``selector="current"`` to a concrete context name.

    ``$NATS_CONTEXT`` wins; otherwise read the selection file written by
    ``nats context select``. Missing both raises :class:`NatsContextError`.
    """
    env_name = os.environ.get("NATS_CONTEXT")
    if env_name:
        return env_name
    selection = _selection_file()
    try:
        selected = selection.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise NatsContextError(
            f"no NATS context is selected ($NATS_CONTEXT unset, no {selection})"
        ) from exc
    if not selected:
        raise NatsContextError(f"no NATS context is selected (empty {selection})")
    return selected


def _split_urls(url: str) -> list[str]:
    """Split a context's ``url`` field into individual server URLs."""
    return [part.strip() for part in url.split(",") if part.strip()]


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


__all__ = ["load_context_options"]
