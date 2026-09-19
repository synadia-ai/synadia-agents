"""Evidence artifacts retain useful shape without retaining identity secrets."""

from __future__ import annotations

from pathlib import Path

from tests.harness.evidence import EvidenceRecorder


def test_evidence_recorder_recursively_redacts_security_material(tmp_path: Path) -> None:
    recorder = EvidenceRecorder.for_test(tmp_path, "redaction")
    secrets = {
        "header": "agent-sender-secret",
        "request": "request-info-jwt-secret",
        "jwt": "jwt-secret",
        "seed": "seed-secret",
        "nonce": "nonce-secret",
        "signature": "signature-secret",
        "token": "token-secret",
    }
    artifact = recorder.write_json(
        "artifact.json",
        {
            "headers": {
                "Agent-Sender": secrets["header"],
                "Nats-Request-Info": secrets["request"],
                "X-Public": "kept",
            },
            "nested": {
                "jwt": secrets["jwt"],
                "seed": secrets["seed"],
                "nonce": secrets["nonce"],
                "signature": secrets["signature"],
                "token": secrets["token"],
            },
        },
    )
    rendered = artifact.read_text(encoding="utf-8")
    assert "kept" in rendered
    assert rendered.count("[redacted]") == 7
    assert not any(secret in rendered for secret in secrets.values())
