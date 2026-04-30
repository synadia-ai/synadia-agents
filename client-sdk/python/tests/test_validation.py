"""Unit tests for :mod:`synadia_ai.agents.validation` (§5.4 pre-publish checks).

Pure tests — the assertions are synchronous and don't touch NATS. The e2e
companion in ``test_validation_e2e.py`` verifies the assertions fire from
``Agent.prompt`` before any wire traffic.
"""

from __future__ import annotations

import pytest

from synadia_ai.agents import (
    AttachmentsNotSupportedError,
    PayloadTooLargeError,
    PromptEmptyError,
    ValidationError,
)
from synadia_ai.agents.validation import (
    assert_attachments_allowed,
    assert_prompt_non_empty,
    assert_within_max_payload,
)


class TestPromptNonEmpty:
    def test_empty_rejected(self) -> None:
        with pytest.raises(PromptEmptyError):
            assert_prompt_non_empty("")

    def test_whitespace_accepted(self) -> None:
        # §5.1 requires non-empty, not non-blank.
        assert_prompt_non_empty(" ")
        assert_prompt_non_empty("\n")

    def test_non_empty_accepted(self) -> None:
        assert_prompt_non_empty("hello")


class TestAttachmentsAllowed:
    def test_attachments_with_ok_true(self) -> None:
        assert_attachments_allowed(True, True)

    def test_no_attachments_ignores_flag(self) -> None:
        assert_attachments_allowed(False, False)
        assert_attachments_allowed(False, True)
        assert_attachments_allowed(False, None)

    def test_attachments_with_ok_false_raises(self) -> None:
        with pytest.raises(AttachmentsNotSupportedError):
            assert_attachments_allowed(True, False)

    def test_attachments_with_ok_none_is_permissive(self) -> None:
        """No declared capability ⇒ local check is skipped (agent decides)."""
        assert_attachments_allowed(True, None)


class TestWithinMaxPayload:
    def test_within_limit(self) -> None:
        assert_within_max_payload(100, 1024)

    def test_exactly_at_limit(self) -> None:
        assert_within_max_payload(1024, 1024)

    def test_over_limit_raises_with_context(self) -> None:
        with pytest.raises(PayloadTooLargeError) as excinfo:
            assert_within_max_payload(2048, 1024)
        err = excinfo.value
        assert err.limit == 1024
        assert err.actual == 2048

    def test_no_declared_limit_is_permissive(self) -> None:
        """No declared capability ⇒ skip local check (agent decides)."""
        assert_within_max_payload(10**9, None)

    def test_connection_limit_alone_enforced(self) -> None:
        """Endpoint silent, connection caps at 1KB ⇒ 2KB still rejected."""
        with pytest.raises(PayloadTooLargeError) as excinfo:
            assert_within_max_payload(2048, None, connection_max_payload=1024)
        assert excinfo.value.limit == 1024
        assert excinfo.value.actual == 2048

    def test_smaller_of_endpoint_and_connection_wins(self) -> None:
        """Agent advertises 8MB but caller's broker caps at 1MB ⇒ cap is 1MB."""
        eight_mb = 8 * 1024 * 1024
        one_mb = 1024 * 1024
        # Within both
        assert_within_max_payload(512, eight_mb, connection_max_payload=one_mb)
        # Within agent, over connection
        with pytest.raises(PayloadTooLargeError) as excinfo:
            assert_within_max_payload(2 * one_mb, eight_mb, connection_max_payload=one_mb)
        assert excinfo.value.limit == one_mb

    def test_endpoint_smaller_than_connection_still_caps(self) -> None:
        """Reverse direction: endpoint is the binding cap."""
        with pytest.raises(PayloadTooLargeError) as excinfo:
            assert_within_max_payload(2048, 1024, connection_max_payload=8 * 1024 * 1024)
        assert excinfo.value.limit == 1024

    def test_both_none_is_permissive(self) -> None:
        assert_within_max_payload(10**9, None, connection_max_payload=None)


def test_all_validation_errors_share_base() -> None:
    """Callers can `except ValidationError` to catch the whole family."""
    for exc_cls in (PromptEmptyError, AttachmentsNotSupportedError):
        assert issubclass(exc_cls, ValidationError)
    assert issubclass(PayloadTooLargeError, ValidationError)
