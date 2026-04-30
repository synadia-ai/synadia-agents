"""Unit tests for :meth:`AgentService._effective_max_payload`.

The clamp logic doesn't need a live broker — it only consults the
constructor's ``max_payload`` and the connection's ``max_payload``
property. Hand it a ``MagicMock`` standing in for ``nats-py``'s
``Client`` so the test exercises the matrix in isolation.
"""

from __future__ import annotations

import logging
from unittest.mock import MagicMock

import pytest

from synadia_ai.agent_service import AgentService


def _make_service(
    *, max_payload: str = "1MB", server_max_payload: int | None = None
) -> AgentService:
    nc = MagicMock()
    nc.max_payload = server_max_payload
    return AgentService(
        agent="test",
        owner="pytest",
        session_name="clamp",
        nc=nc,
        max_payload=max_payload,
    )


class TestEffectiveMaxPayload:
    def test_override_smaller_than_server_is_honored(self) -> None:
        # Operator wants a tighter cap (e.g. shed expensive prompts before
        # they reach the handler) — that's allowed, no clamp.
        svc = _make_service(max_payload="256KB", server_max_payload=8 * 1024 * 1024)
        assert svc._effective_max_payload() == "256KB"

    def test_override_equal_to_server_is_honored(self) -> None:
        svc = _make_service(max_payload="1MB", server_max_payload=1024 * 1024)
        assert svc._effective_max_payload() == "1MB"

    def test_override_larger_than_server_clamps_down(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        svc = _make_service(max_payload="16MB", server_max_payload=8 * 1024 * 1024)
        with caplog.at_level(logging.WARNING, logger="synadia_ai.agent_service.service"):
            advertised = svc._effective_max_payload()
        assert advertised == "8MB"
        assert any("clamping advertised value to 8MB" in rec.message for rec in caplog.records)

    def test_no_server_info_means_override_stands(self) -> None:
        # `nc.max_payload == 0` (or absent) → unconnected client / INFO
        # without `max_payload`. Nothing to clamp against; honour the
        # override as configured.
        svc = _make_service(max_payload="16MB", server_max_payload=0)
        assert svc._effective_max_payload() == "16MB"

    def test_server_info_unset_attribute_means_override_stands(self) -> None:
        nc = MagicMock(spec=[])  # no `max_payload` attribute at all
        svc = AgentService(
            agent="test",
            owner="pytest",
            session_name="clamp-no-attr",
            nc=nc,
            max_payload="16MB",
        )
        assert svc._effective_max_payload() == "16MB"
