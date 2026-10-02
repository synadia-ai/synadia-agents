"""Save received attachments to disk.

The receiving counterpart of :meth:`Attachment.from_path`. A reply's
attachments (§6.3) and a mid-stream query's (§7.1) arrive as
:class:`~synadia_ai.agents.envelope.Attachment` — ``{filename, content:
<base64>}``. :func:`save_attachments` decodes each one and writes it into a
directory, so a caller can hand its model a list of paths instead of base64.
The name comes from another agent and is untrusted: only its last path
component survives, sanitized, and a file is only ever created — never
overwritten, never reached through a link.

The TypeScript SDK's ``saveAttachments`` (``src/prompt/save-attachments.ts``)
behaves the same; ``test-fixtures/attachments/`` holds the shared cases.
"""

from __future__ import annotations

import base64
import contextlib
import math
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .envelope import Attachment

DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES = 64 * 1024 * 1024
"""Default ``max_total_bytes`` of :func:`save_attachments`: 64 MiB of decoded bytes per call."""

_MAX_NAME_BYTES = 200
"""A name longer than this many UTF-8 bytes is shortened."""

_MAX_EXTENSION_CHARS = 16
"""An extension (dot included) up to this many characters survives shortening."""

_MAX_NAME_ATTEMPTS = 1000
"""``<stem> (2)<ext>`` … ``<stem> (1000)<ext>``, then give up."""

_FILE_MODE = 0o600
"""Mode of a saved file (POSIX)."""

_DIRECTORY_MODE = 0o700
"""Mode of a directory :func:`save_attachments` creates (POSIX)."""

_STRICT_BASE64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")

# Stripped from both ends of a name: dots, and the union of what Python's
# ``str.isspace()`` and JavaScript's ``\s`` call whitespace (control
# characters are removed before this runs), so both SDKs trim alike.
_EDGE_CHARS = (
    " .\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

# Removed from a name: C0 controls, DEL and C1 controls (U+009B, for one,
# starts a terminal escape sequence); direction marks, embeddings, overrides
# and isolates, which let a shown name be spoofed (``evil<U+202E>txt.exe``
# shows as ``evilexe.txt``). Replaced by U+FFFD, as in TypeScript:
# lone surrogates, which JSON allows and no file system encodes. Replaced
# by ``_``: the characters Windows forbids in a name, besides the
# separators and control characters handled already — on every OS, so a
# name comes out the same wherever it is saved.
_NAME_TRANSLATION: dict[int, int | None] = {
    **dict.fromkeys([*range(0x20), *range(0x7F, 0xA0)]),
    **dict.fromkeys([0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A)]),
    **dict.fromkeys(range(0xD800, 0xE000), 0xFFFD),
    **dict.fromkeys(map(ord, '<>:"|?*'), ord("_")),
}

# A Windows device name (Microsoft's list: CON, PRN, AUX, NUL, COM1 to COM9,
# LPT1 to LPT9, COM and LPT with a superscript ¹ ² ³; and the console's
# CONIN$ and CONOUT$), any case, alone or before a dot: ``NUL.tar.gz`` is the
# device too. Spaces before the dot are ignored, on the side of caution, as
# ``os.path.isreserved`` does.
# ``re.ASCII``: only ASCII letters match case-insensitively, as in
# TypeScript.
_WINDOWS_DEVICE_NAME = re.compile(
    r"(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9\u00b9\u00b2\u00b3]) *(?:\.|\Z)",
    re.IGNORECASE | re.ASCII,
)


@dataclass(frozen=True, slots=True)
class SavedAttachment:
    """What :func:`save_attachments` did with one attachment.

    ``filename`` is the name exactly as the sender gave it (the file on disk
    may differ; see ``path``). ``size_bytes`` is the decoded size, ``0``
    when the content was invalid. ``path`` is the absolute path of the
    written file, ``None`` when the attachment was not saved — and then
    ``skipped`` says why.
    """

    filename: str
    size_bytes: int
    path: Path | None
    skipped: Literal["over_limit", "invalid_content"] | None = None


def save_attachments(
    attachments: Iterable[Attachment],
    directory: str | os.PathLike[str],
    *,
    max_total_bytes: int | None = DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES,
) -> list[SavedAttachment]:
    """Decode received attachments and write each into ``directory``.

    The directory is created if missing. Attachments are processed in
    order; the result has one :class:`SavedAttachment` per input, in the
    same order.

    - **Content** must be strict RFC 4648 §4 base64 (§5.2: standard
      alphabet, padded, no whitespace). Anything else is not written:
      ``skipped="invalid_content"``. Bad content never raises.
    - **Name**: the part after the last ``/`` or ``\\``, control characters
      and the characters that change text direction (U+200E, U+200F,
      U+202A to U+202E, U+2066 to U+2069) removed, ``< > : " | ? *``
      replaced by ``_``, leading and trailing dots and whitespace stripped,
      ``attachment-<n>`` (1-based position) when nothing is left, shortened
      to 200 UTF-8 bytes keeping an extension of up to 16 characters, and a
      Windows device name (``CON``, ``nul.txt``, ``COM1.log``) prefixed with
      ``_``. The same on every OS.
    - **Never overwrites, never follows a link**: each file is created
      exclusively; on a clash (an earlier attachment, a file or a symlink
      already there) the next free ``<stem> (2)<ext>``, ``(3)``, … is used.
    - **Private**: on POSIX a file is created with mode 0600 and a directory
      this call creates, ``directory`` or a missing parent, with 0700; a
      directory that already exists keeps its mode.
    - **Limit**: ``max_total_bytes`` bounds the decoded bytes this call
      writes, summed over the attachments it saves. An attachment that
      would push the total past it is skipped (``skipped="over_limit"``); a
      later, smaller one may still fit. ``None`` disables the limit.

    Real I/O errors (permissions, disk full) are raised as :class:`OSError`;
    a file this call created and could not finish writing is removed first.
    """
    # NaN compares false to everything and would disable the limit silently.
    if max_total_bytes is not None and (math.isnan(max_total_bytes) or max_total_bytes < 0):
        raise ValueError(
            "save_attachments: max_total_bytes must be a non-negative int or None "
            f"(got {max_total_bytes})"
        )
    root = Path(os.path.abspath(directory))
    _make_directory(root)

    saved: list[SavedAttachment] = []
    total = 0
    for position, attachment in enumerate(attachments, start=1):
        size = _strict_base64_size(attachment.content)
        if size is None:
            saved.append(SavedAttachment(attachment.filename, 0, None, "invalid_content"))
            continue
        if max_total_bytes is not None and total + size > max_total_bytes:
            saved.append(SavedAttachment(attachment.filename, size, None, "over_limit"))
            continue
        data = base64.b64decode(attachment.content, validate=True)
        path = _create_exclusive(root, _safe_name(attachment.filename, position), data)
        total += size
        saved.append(SavedAttachment(attachment.filename, size, path))
    return saved


def _strict_base64_size(content: str) -> int | None:
    """Decoded size of strict RFC 4648 §4 base64, or ``None`` when it is not.

    Computed from the text, so an attachment over the limit is never
    decoded. ``fullmatch``, not ``$``: ``$`` would also match before a
    trailing newline. The decode that follows (``validate=True``) agrees on
    every string this accepts.
    """
    if len(content) % 4 != 0 or _STRICT_BASE64.fullmatch(content) is None:
        return None
    padding = 2 if content.endswith("==") else 1 if content.endswith("=") else 0
    return len(content) // 4 * 3 - padding


def _safe_name(name: str, position: int) -> str:
    """The name an attachment is saved under, before any ``(n)`` suffix.

    ``position`` is the attachment's 1-based place in the input. See
    :func:`save_attachments` for the rules.
    """
    last_separator = max(name.rfind("/"), name.rfind("\\"))
    kept = name[last_separator + 1 :].translate(_NAME_TRANSLATION).strip(_EDGE_CHARS)
    if not kept:
        return f"attachment-{position}"
    kept = _shorten(kept)
    # Checked after shortening, since a cut can leave one (``CON`` + spaces + …).
    return _shorten(f"_{kept}") if _WINDOWS_DEVICE_NAME.match(kept) else kept


def _shorten(name: str) -> str:
    if len(name.encode("utf-8")) <= _MAX_NAME_BYTES:
        return name
    stem, ext = _split_extension(name)
    if len(ext) > _MAX_EXTENSION_CHARS:
        stem, ext = name, ""
    budget = _MAX_NAME_BYTES - len(ext.encode("utf-8"))
    kept: list[str] = []
    used = 0
    for ch in stem:
        size = len(ch.encode("utf-8"))
        if used + size > budget:
            break
        kept.append(ch)
        used += size
    # The cut may land after a dot or a space; the name must not end on one.
    return "".join(kept).rstrip(_EDGE_CHARS) + ext


def _split_extension(name: str) -> tuple[str, str]:
    """``("archive.tar", ".gz")``; no extension when there is no dot past the first character."""
    dot = name.rfind(".")
    return (name[:dot], name[dot:]) if dot > 0 else (name, "")


def _make_directory(path: Path) -> None:
    """``mkdir -p`` that gives every directory it creates mode 0700.

    A directory that already exists keeps its mode. ``Path.mkdir(parents=
    True, mode=…)`` and ``os.makedirs`` would give the mode to the last
    directory only, the parents they create getting the default.
    """
    if path.is_dir():
        return
    if path.parent != path:
        _make_directory(path.parent)
    try:
        os.mkdir(path, _DIRECTORY_MODE)
    except FileExistsError:
        # Created meanwhile is fine; a file in the way is not.
        if not path.is_dir():
            raise


def _open_private(path: str, flags: int) -> int:
    """``open``'s opener: the flags ``open`` chose, and mode 0600."""
    return os.open(path, flags, _FILE_MODE)


def _create_exclusive(root: Path, name: str, data: bytes) -> Path:
    """Create ``name`` in ``root`` exclusively, trying ``<stem> (n)<ext>`` on a clash.

    ``open(…, "xb")`` is ``O_CREAT | O_EXCL``, which fails on any existing
    entry, a symlink included, without following it; the file gets mode
    0600. Returns the absolute path written.
    """
    stem, ext = _split_extension(name)
    for attempt in range(1, _MAX_NAME_ATTEMPTS + 1):
        path = root / (name if attempt == 1 else f"{stem} ({attempt}){ext}")
        try:
            handle = open(path, "xb", opener=_open_private)  # noqa: SIM115 — closed below, removed on a failed write
        except FileExistsError:
            continue
        try:
            with handle:
                handle.write(data)
        except BaseException:
            with contextlib.suppress(OSError):
                path.unlink()
            raise
        return path
    raise FileExistsError(
        f"save_attachments: no free name for {name!r} in {root} after {_MAX_NAME_ATTEMPTS} attempts"
    )
