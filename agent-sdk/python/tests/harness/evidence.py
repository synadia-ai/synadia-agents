"""Per-test evidence recording.

The :class:`EvidenceRecorder` subscribes to `agents.>` and `$SRV.>` and writes
every observed message to `messages.jsonl` in the evidence directory. Tests
also write explicit artifacts (`srv-info.json`, `chunks.jsonl`, etc.) into the
same directory. On failure the evidence is preserved for eyeball review.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


@dataclass(slots=True)
class EvidenceRecorder:
    """Captures NATS traffic to a per-test evidence directory."""

    directory: Path
    messages_path: Path
    _nc: NATSClient | None = None
    _sub_agents: object | None = None
    _sub_srv: object | None = None
    _sub_inbox: object | None = None

    @classmethod
    def for_test(cls, evidence_root: Path, nodeid: str) -> EvidenceRecorder:
        # Normalize the pytest nodeid into a filesystem-safe directory name.
        safe = nodeid.replace("/", "_").replace("::", "__").replace("[", "_").replace("]", "_")
        directory = evidence_root / safe
        directory.mkdir(parents=True, exist_ok=True)
        return cls(directory=directory, messages_path=directory / "messages.jsonl")

    async def attach(self, nc: NATSClient) -> None:
        """Subscribe to the wildcards we want to spy on. Idempotent per recorder.

        We spy on `agents.>` and `$SRV.>` for agent-bound traffic, plus `_INBOX.>`
        so the reply stream (chunked prompt replies + empty-payload terminators)
        is captured. Without the inbox spy the `messages.jsonl` would only show
        one side of each request/reply and miss the streamed chunks entirely.
        """
        self._nc = nc
        # Truncate the messages log for this run so it reflects a single test.
        self.messages_path.write_bytes(b"")
        self._sub_agents = await nc.subscribe("agents.>", cb=self._write_msg)
        self._sub_srv = await nc.subscribe("$SRV.>", cb=self._write_msg)
        self._sub_inbox = await nc.subscribe("_INBOX.>", cb=self._write_msg)

    async def detach(self) -> None:
        for sub in (self._sub_agents, self._sub_srv, self._sub_inbox):
            if sub is not None:
                await sub.unsubscribe()  # type: ignore[attr-defined]
        self._sub_agents = None
        self._sub_srv = None
        self._sub_inbox = None

    async def _write_msg(self, msg: object) -> None:
        subject: str = msg.subject  # type: ignore[attr-defined]
        data: bytes = msg.data  # type: ignore[attr-defined]
        reply: str = msg.reply  # type: ignore[attr-defined]
        headers = getattr(msg, "headers", None) or {}

        record = {
            "ts": datetime.now(UTC).isoformat(),
            "subject": subject,
            "reply": reply or None,
            "headers": dict(headers) if headers else None,
            "data": _render_payload(data),
        }
        with self.messages_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")

    def write_json(self, name: str, payload: object) -> Path:
        """Dump a structured artifact into the evidence directory."""
        path = self.directory / name
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return path

    def write_jsonl(self, name: str, records: list[object]) -> Path:
        path = self.directory / name
        with path.open("w", encoding="utf-8") as handle:
            for rec in records:
                handle.write(json.dumps(rec) + "\n")
        return path


def _render_payload(data: bytes) -> object:
    """Render a NATS payload in the most reviewable form for `messages.jsonl`.

    Empty → null so readers see stream terminators at a glance.
    Valid JSON → parsed object (so a human reading the log sees structure, not escaped JSON).
    Otherwise UTF-8 text if possible, else a hex preview + length.
    """
    if not data:
        return None
    try:
        return json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass
    try:
        return {"text": data.decode("utf-8")}
    except UnicodeDecodeError:
        return {"hex": data[:64].hex(), "length": len(data)}
