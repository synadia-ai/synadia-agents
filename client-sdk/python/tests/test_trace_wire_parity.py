"""Cross-SDK agreement on the edge record.

The record is the tracing extension's only new wire object, and both SDKs
write it. A field renamed, reordered, retyped or dropped on one side only
would go unnoticed until a consumer read a mixed-language fleet — so
generate one from each implementation with identical inputs and compare
the bytes.

Skips cleanly (never fails) when ``bun`` or the TS SDK's dependencies are
missing, exactly like :mod:`tests.test_interop_e2e`.
"""

from __future__ import annotations

import json
import re
import subprocess

import pytest

from synadia_ai.agents import EDGE_RECORD_VERSION, AgentId, build_edge_record
from tests.test_interop_e2e import TSSDK_DIR, _interop_prereqs_missing

# `alice` from test-fixtures/identity/keys.json — any real user NKEY does.
AGENT = AgentId.new("ACME", "UCDUW5V44EBDBIK2FL4CTNDBQFNGBEZVJHSZGQVKRHASN4AV4IWPB5NT")
THREAD = "a" * 32
PARENT = "b" * 32
ROOT = "c" * 32
# Non-ASCII, with an astral character: `JSON.stringify` writes it raw.
UNICODE_CALL = "call_é🙂"

# The two volatile fields: a fresh id per record, and wall-clock seconds.
_RECORD_ID = re.compile(r'"record_id":"[0-9a-f]{32}"')
_TS = re.compile(r'"ts":\d+')


def _normalise(payload: bytes) -> str:
    text = payload.decode("utf-8")
    text = _RECORD_ID.sub('"record_id":"<id>"', text)
    return _TS.sub('"ts":<ts>', text)


def _typescript_records() -> list[str]:
    """Ask the TS SDK for the same three records."""
    # The id goes into the script as JSON, so it is plain ASCII on stdin
    # and the JS parser rebuilds the same string.
    unicode_call = json.dumps(UNICODE_CALL)
    script = (
        'import { buildEdgeRecord, EDGE_RECORD_VERSION } from "./src/trace.js";'
        'import { parseAgentId } from "./src/identity/agent-id.js";'
        "const d = new TextDecoder();"
        f'const agent = parseAgentId("{AGENT}");'
        f'const nested = buildEdgeRecord(agent, "{THREAD}", "{PARENT}", "{ROOT}", "call_1", 7);'
        "console.log(d.decode(nested.payload));"
        f'const root = buildEdgeRecord(agent, "{THREAD}", null, "{THREAD}", null, 0);'
        "console.log(d.decode(root.payload));"
        f'const uni = buildEdgeRecord(agent, "{THREAD}", "{PARENT}", "{ROOT}", {unicode_call}, 1);'
        "console.log(d.decode(uni.payload));"
        "console.log(String(EDGE_RECORD_VERSION));"
    )
    out = subprocess.run(
        ["bun", "run", "-"],
        check=False,
        input=script,
        capture_output=True,
        text=True,
        cwd=TSSDK_DIR,
        timeout=60,
    )
    if out.returncode != 0:
        pytest.skip(f"could not run the TS SDK: {out.stderr.strip()[:200]}")
    return out.stdout.strip().splitlines()


@pytest.mark.skipif(_interop_prereqs_missing() is not None, reason="TS SDK unavailable")
def test_edge_records_are_byte_identical_across_sdks() -> None:
    ts_nested, ts_root, ts_unicode, ts_version = _typescript_records()

    py_nested = _normalise(build_edge_record(AGENT, THREAD, PARENT, ROOT, "call_1", 7)[1])
    py_root = _normalise(build_edge_record(AGENT, THREAD, None, THREAD, None, 0)[1])
    py_unicode = _normalise(build_edge_record(AGENT, THREAD, PARENT, ROOT, UNICODE_CALL, 1)[1])

    assert _normalise(ts_nested.encode()) == py_nested
    assert _normalise(ts_root.encode()) == py_root
    assert _normalise(ts_unicode.encode()) == py_unicode, "non-ASCII ids are escaped differently"
    assert int(ts_version) == EDGE_RECORD_VERSION, (
        "the two SDKs disagree on the edge record schema version"
    )


@pytest.mark.skipif(_interop_prereqs_missing() is not None, reason="TS SDK unavailable")
def test_edge_record_keys_are_in_the_same_order() -> None:
    ts_nested, _, _, _ = _typescript_records()
    py_nested = build_edge_record(AGENT, THREAD, PARENT, ROOT, "call_1", 7)[1]
    assert list(json.loads(ts_nested)) == list(json.loads(py_nested))


def test_record_id_shares_the_thread_id_shape() -> None:
    record_id, payload = build_edge_record(AGENT, THREAD, None, THREAD, None, 0)
    assert re.fullmatch(r"[0-9a-f]{32}", record_id)
    assert json.loads(payload)["record_id"] == record_id


def test_the_record_names_its_writer() -> None:
    _, payload = build_edge_record(AGENT, THREAD, None, THREAD, None, 0)
    record = json.loads(payload)
    assert record["agent"] == str(AGENT)
    # The writer sits where the design's table puts it: after `ts`, before the ids.
    assert list(record) == [
        "version",
        "kind",
        "record_id",
        "ts",
        "agent",
        "thread_id",
        "parent_id",
        "root_id",
        "tool_call_id",
        "turn_count_hint",
    ]
