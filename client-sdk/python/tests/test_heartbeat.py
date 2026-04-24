"""Unit tests for the heartbeat payload shape (§8.3).

Round-trips the canonical example from spec appendix B.11 and exercises the
forward-compat requirement that unknown fields are tolerated.
"""

from __future__ import annotations

import json

from natsagent.heartbeat import HeartbeatPayload


def test_decodes_spec_example() -> None:
    """Appendix B.11 — exact wire shape with session + instance_id."""
    wire = (
        b'{"agent":"claude-code","owner":"aconnolly","session":"synadia-com-2",'
        b'"instance_id":"VMKS6MHK71PCPWGY38A7N5",'
        b'"ts":"2026-04-21T14:23:01Z","interval_s":30}'
    )
    hb = HeartbeatPayload.model_validate_json(wire)
    assert hb.agent == "claude-code"
    assert hb.owner == "aconnolly"
    assert hb.session == "synadia-com-2"
    assert hb.instance_id == "VMKS6MHK71PCPWGY38A7N5"
    assert hb.ts == "2026-04-21T14:23:01Z"
    assert hb.interval_s == 30


def test_session_optional() -> None:
    """Session-less harnesses (openclaw) omit the field on the wire."""
    wire = (
        b'{"agent":"openclaw","owner":"rene","instance_id":"ABC",'
        b'"ts":"2026-04-21T00:00:00Z","interval_s":30}'
    )
    hb = HeartbeatPayload.model_validate_json(wire)
    assert hb.session is None


def test_unknown_fields_tolerated() -> None:
    """§8.3: receivers MUST tolerate additional unknown fields."""
    wire = (
        b'{"agent":"claude-code","owner":"alice","instance_id":"X",'
        b'"ts":"2026-04-21T00:00:00Z","interval_s":30,'
        b'"future_field":42,"another":"ok"}'
    )
    hb = HeartbeatPayload.model_validate_json(wire)
    assert hb.agent == "claude-code"


def test_encoded_form_omits_session_when_absent() -> None:
    """Session-less payloads MUST NOT emit an empty `session` key on the wire."""
    hb = HeartbeatPayload(
        agent="openclaw",
        owner="rene",
        instance_id="X",
        ts="2026-04-21T00:00:00Z",
        interval_s=30,
    )
    parsed = json.loads(hb.model_dump_json(exclude_none=True))
    assert "session" not in parsed
    assert parsed == {
        "agent": "openclaw",
        "owner": "rene",
        "instance_id": "X",
        "ts": "2026-04-21T00:00:00Z",
        "interval_s": 30,
    }


def test_encoded_form_includes_session_when_present() -> None:
    hb = HeartbeatPayload(
        agent="claude-code",
        owner="alice",
        session="proj-1",
        instance_id="X",
        ts="2026-04-21T00:00:00Z",
        interval_s=30,
    )
    parsed = json.loads(hb.model_dump_json(exclude_none=True))
    assert parsed["session"] == "proj-1"
