"""``save_attachments`` — the receiving counterpart of ``Attachment.from_path`` (unit, no server).

The name and base64 tables live in ``test-fixtures/attachments/``, shared
with the TypeScript suite (``test/unit/save-attachments.test.ts``), so both
SDKs save a reply's files under the same names. The behaviour tests below
(clashes, links, the limit, I/O errors) run against a real temp dir.
"""

from __future__ import annotations

import base64
import errno
import json
import os
import signal
import sys
from pathlib import Path
from typing import Any

import pytest

if sys.platform != "win32":
    import resource

import synadia_ai.agents as package
from synadia_ai.agents import (
    DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES,
    Attachment,
    SavedAttachment,
    save_attachments,
)
from synadia_ai.agents.attachments import _safe_name

# tests/ → python/ → client-sdk/ → repo root.
FIXTURES_DIR = Path(__file__).resolve().parents[3] / "test-fixtures" / "attachments"
NAMES: dict[str, Any] = json.loads((FIXTURES_DIR / "save-names.json").read_text(encoding="utf-8"))
BASE64: dict[str, Any] = json.loads(
    (FIXTURES_DIR / "base64-content.json").read_text(encoding="utf-8")
)


def att(filename: str, text: str) -> Attachment:
    return Attachment.from_bytes(filename, text.encode("utf-8"))


# --- test-fixtures/attachments/save-names.json ---------------------------------


def test_names_fixture_limits() -> None:
    assert NAMES["max_name_bytes"] == 200
    assert NAMES["max_extension_chars"] == 16
    assert len(NAMES["names"]) >= 20


@pytest.mark.parametrize("row", NAMES["names"], ids=[r["note"] for r in NAMES["names"]])
def test_safe_name_fixture_row(row: dict[str, Any]) -> None:
    name = _safe_name(row["input"], row.get("position", 1))
    assert name == row["expected"]
    assert len(name.encode("utf-8")) <= NAMES["max_name_bytes"]


def test_saves_every_fixture_name_under_its_expected_name(tmp_path: Path) -> None:
    for i, row in enumerate(NAMES["names"]):
        directory = tmp_path / f"row-{i}"
        position = row.get("position", 1)
        # Fillers with invalid content take the earlier positions and write nothing.
        fillers = [Attachment(filename="", content=f"!{k}") for k in range(position - 1)]
        result = save_attachments([*fillers, att(row["input"], "x")], directory)
        entry = result[position - 1]
        assert entry.filename == row["input"]
        assert entry.path is not None
        assert entry.path.name == row["expected"]
        assert [p.name for p in directory.iterdir()] == [row["expected"]]


# --- test-fixtures/attachments/base64-content.json -----------------------------


@pytest.mark.parametrize("row", BASE64["cases"], ids=[repr(r["content"]) for r in BASE64["cases"]])
def test_base64_fixture_row(row: dict[str, Any], tmp_path: Path) -> None:
    (entry,) = save_attachments([Attachment(filename="f.bin", content=row["content"])], tmp_path)
    if row["valid"]:
        expected = bytes.fromhex(row["hex"])
        assert entry == SavedAttachment("f.bin", len(expected), tmp_path / "f.bin")
        assert (tmp_path / "f.bin").read_bytes() == expected
    else:
        assert entry == SavedAttachment("f.bin", 0, None, "invalid_content")
        assert list(tmp_path.iterdir()) == []


# --- behaviour ------------------------------------------------------------------


def test_exported_with_a_64_mib_default() -> None:
    assert DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES == 64 * 1024 * 1024
    for name in ("DEFAULT_SAVE_ATTACHMENTS_MAX_TOTAL_BYTES", "SavedAttachment", "save_attachments"):
        assert name in package.__all__


def test_creates_the_directory_and_returns_absolute_paths_inside_it(tmp_path: Path) -> None:
    directory = tmp_path / "a" / "b" / "c"
    result = save_attachments([att("hello.txt", "hi")], directory)
    assert result == [SavedAttachment("hello.txt", 2, directory / "hello.txt")]
    path = result[0].path
    assert path is not None
    assert path.is_absolute()
    assert path.parent == directory
    assert path.read_text(encoding="utf-8") == "hi"


def test_resolves_a_relative_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    (entry,) = save_attachments([att("r.txt", "r")], "rel")
    assert entry.path == Path(os.path.abspath("rel")) / "r.txt"
    assert entry.path.is_absolute()


def test_no_attachments_still_creates_the_directory(tmp_path: Path) -> None:
    directory = tmp_path / "empty"
    assert save_attachments([], directory) == []
    assert directory.is_dir()


def test_duplicate_names_get_a_suffix(tmp_path: Path) -> None:
    result = save_attachments(
        [
            att("a.txt", "one"),
            att("a.txt", "two"),
            att("dir/a.txt", "three"),
            att("README", "r1"),
            att("README", "r2"),
        ],
        tmp_path,
    )
    assert [r.path.name for r in result if r.path] == [
        "a.txt",
        "a (2).txt",
        "a (3).txt",
        "README",
        "README (2)",
    ]
    assert [r.filename for r in result] == ["a.txt", "a.txt", "dir/a.txt", "README", "README"]
    assert (tmp_path / "a (2).txt").read_text(encoding="utf-8") == "two"


def test_never_overwrites_a_file_already_on_disk(tmp_path: Path) -> None:
    (tmp_path / "a.txt").write_text("original", encoding="utf-8")
    (entry,) = save_attachments([att("a.txt", "new")], tmp_path)
    assert entry.path == tmp_path / "a (2).txt"
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "original"
    assert entry.path.read_text(encoding="utf-8") == "new"


def test_never_follows_a_symlink_live_or_dangling(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    target = outside / "target.txt"
    target.write_text("original", encoding="utf-8")
    dangling = outside / "never-created.txt"
    directory = tmp_path / "inbox"
    directory.mkdir()
    (directory / "a.txt").symlink_to(target)
    (directory / "b.txt").symlink_to(dangling)

    result = save_attachments([att("a.txt", "evil"), att("b.txt", "evil")], directory)

    assert [r.path.name for r in result if r.path] == ["a (2).txt", "b (2).txt"]
    assert target.read_text(encoding="utf-8") == "original"
    assert not dangling.exists()
    assert (directory / "a.txt").is_symlink()
    assert os.readlink(directory / "b.txt") == str(dangling)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX modes")
def test_files_are_0600_and_created_directories_0700(tmp_path: Path) -> None:
    def mode(path: Path) -> int:
        return path.lstat().st_mode & 0o777

    tmp_path.chmod(0o755)
    directory = tmp_path / "a" / "b"
    result = save_attachments([att("f.txt", "f"), att("f.txt", "g")], directory)
    assert [mode(r.path) for r in result if r.path] == [0o600, 0o600]
    assert mode(tmp_path / "a") == 0o700
    assert mode(directory) == 0o700
    assert mode(tmp_path) == 0o755

    # An existing directory keeps its mode.
    existing = tmp_path / "existing"
    existing.mkdir()
    existing.chmod(0o755)
    (entry,) = save_attachments([att("e.txt", "e")], existing)
    assert entry.path is not None
    assert mode(entry.path) == 0o600
    assert mode(existing) == 0o755


def test_skips_over_the_limit_and_still_saves_a_later_smaller_one(tmp_path: Path) -> None:
    result = save_attachments(
        [att("six.bin", "123456"), att("five.bin", "12345"), att("four.bin", "1234")],
        tmp_path,
        max_total_bytes=10,
    )
    assert result == [
        SavedAttachment("six.bin", 6, tmp_path / "six.bin"),
        SavedAttachment("five.bin", 5, None, "over_limit"),
        SavedAttachment("four.bin", 4, tmp_path / "four.bin"),
    ]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["four.bin", "six.bin"]


def test_invalid_content_costs_nothing_against_the_limit(tmp_path: Path) -> None:
    result = save_attachments(
        [Attachment(filename="bad.bin", content="aGVsbG8"), att("ok.bin", "12345")],
        tmp_path,
        max_total_bytes=5,
    )
    assert result == [
        SavedAttachment("bad.bin", 0, None, "invalid_content"),
        SavedAttachment("ok.bin", 5, tmp_path / "ok.bin"),
    ]


def test_zero_limit_saves_only_empty_files_and_none_disables_it(tmp_path: Path) -> None:
    zero = save_attachments(
        [att("empty", ""), att("one", "1")], tmp_path / "zero", max_total_bytes=0
    )
    assert [r.skipped for r in zero] == [None, "over_limit"]
    big = Attachment(filename="big.bin", content=base64.b64encode(bytes(1024)).decode("ascii"))
    (entry,) = save_attachments([big], tmp_path / "big", max_total_bytes=None)
    assert entry.size_bytes == 1024


def test_invalid_content_is_listed_in_order_and_not_written(tmp_path: Path) -> None:
    result = save_attachments(
        [
            att("a.txt", "a"),
            Attachment(filename="url-safe.txt", content="aGVsbG8-"),
            att("b.txt", "b"),
        ],
        tmp_path,
    )
    assert [(r.filename, r.skipped or "saved") for r in result] == [
        ("a.txt", "saved"),
        ("url-safe.txt", "invalid_content"),
        ("b.txt", "saved"),
    ]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["a.txt", "b.txt"]


def test_raises_after_1000_names_are_taken(tmp_path: Path) -> None:
    (tmp_path / "x.txt").write_bytes(b"")
    for n in range(2, 1001):
        (tmp_path / f"x ({n}).txt").write_bytes(b"")
    with pytest.raises(FileExistsError, match=r"no free name for 'x\.txt'.*1000 attempts"):
        save_attachments([att("x.txt", "x")], tmp_path)


@pytest.mark.parametrize("limit", [-1, float("nan")])
def test_rejects_a_negative_or_nan_limit(tmp_path: Path, limit: float) -> None:
    with pytest.raises(ValueError, match="max_total_bytes"):
        save_attachments([], tmp_path, max_total_bytes=limit)  # type: ignore[arg-type]


def test_raises_a_real_io_error_when_the_directory_is_a_file(tmp_path: Path) -> None:
    file = tmp_path / "file"
    file.write_bytes(b"")
    with pytest.raises(OSError):
        save_attachments([att("a.txt", "a")], file)


@pytest.mark.skipif(sys.platform == "win32", reason="RLIMIT_FSIZE is POSIX")
def test_removes_a_partly_written_file_before_raising(tmp_path: Path) -> None:
    # A real write failure, no mock: past the soft file-size limit, write()
    # fails with EFBIG once the first 1 KiB is on disk.
    soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
    previous = signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024, hard))
    try:
        with pytest.raises(OSError) as raised:
            save_attachments([att("small.txt", "ok"), att("big.bin", "x" * 4096)], tmp_path)
    finally:
        resource.setrlimit(resource.RLIMIT_FSIZE, (soft, hard))
        signal.signal(signal.SIGXFSZ, previous)
    assert raised.value.errno == errno.EFBIG
    # The file saved before the failure stays; the partial one is gone.
    assert [p.name for p in tmp_path.iterdir()] == ["small.txt"]


@pytest.mark.skipif(
    not hasattr(os, "getuid") or os.getuid() == 0, reason="root ignores directory permissions"
)
def test_raises_a_real_io_error_when_the_directory_is_read_only(tmp_path: Path) -> None:
    tmp_path.chmod(0o500)
    try:
        with pytest.raises(PermissionError):
            save_attachments([att("a.txt", "a")], tmp_path)
    finally:
        tmp_path.chmod(0o700)
