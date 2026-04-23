"""Unit tests for subject construction and validation per protocol §2."""

from __future__ import annotations

import base64

import pytest

from natsagent import AgentSubject
from natsagent.errors import InvalidSubjectToken
from natsagent.subjects import (
    is_heartbeat_subject,
    parse_agent_subject,
)


class TestConstruction:
    def test_valid_simple_tokens(self) -> None:
        subj = AgentSubject.new(agent="occ", owner="derek", name="summarizer")
        assert subj.inbox == "agents.occ.derek.summarizer"
        assert subj.heartbeat == "agents.occ.derek.summarizer.heartbeat"

    def test_hyphens_and_underscores_in_name(self) -> None:
        subj = AgentSubject.new(agent="hermes", owner="rene", name="default_worker-1")
        assert subj.inbox == "agents.hermes.rene.default_worker-1"

    def test_empty_agent_rejected(self) -> None:
        with pytest.raises(InvalidSubjectToken):
            AgentSubject.new(agent="", owner="o", name="n")

    def test_uppercase_agent_rejected(self) -> None:
        with pytest.raises(InvalidSubjectToken):
            AgentSubject.new(agent="Hermes", owner="o", name="n")

    def test_agent_with_underscore_rejected(self) -> None:
        # §2: agent token is hyphens only (no underscore).
        with pytest.raises(InvalidSubjectToken):
            AgentSubject.new(agent="my_agent", owner="o", name="n")


class TestBase64Sanitization:
    """SDK-internal escape — invalid token chars get base64-url-no-padding encoded."""

    def test_owner_with_space_encoded(self) -> None:
        subj = AgentSubject.new(agent="hermes", owner="Rene S", name="default")
        expected_owner = base64.urlsafe_b64encode(b"Rene S").rstrip(b"=").decode("ascii")
        assert subj.owner == expected_owner
        assert subj.inbox.startswith(f"agents.hermes.{expected_owner}.")

    def test_name_with_special_chars_encoded(self) -> None:
        subj = AgentSubject.new(agent="hermes", owner="rene", name="path/to/worker")
        expected_name = base64.urlsafe_b64encode(b"path/to/worker").rstrip(b"=").decode("ascii")
        assert subj.name == expected_name

    def test_already_valid_token_passes_through(self) -> None:
        subj = AgentSubject.new(agent="hermes", owner="rene", name="worker_1-a")
        assert subj.owner == "rene"
        assert subj.name == "worker_1-a"


class TestSubjectClassification:
    def test_is_heartbeat_subject_true(self) -> None:
        assert is_heartbeat_subject("agents.hermes.rene.default.heartbeat") is True

    def test_is_heartbeat_subject_wrong_suffix(self) -> None:
        assert is_heartbeat_subject("agents.hermes.rene.default.attachments") is False

    def test_is_heartbeat_subject_wrong_length(self) -> None:
        assert is_heartbeat_subject("agents.hermes.rene.default") is False
        assert is_heartbeat_subject("agents.hermes.rene.default.heartbeat.extra") is False

    def test_is_heartbeat_subject_wrong_root(self) -> None:
        assert is_heartbeat_subject("other.hermes.rene.default.heartbeat") is False


class TestParseAgentSubject:
    def test_valid_inbox(self) -> None:
        subj = parse_agent_subject("agents.hermes.rene.default")
        assert subj is not None
        assert subj.agent == "hermes"
        assert subj.owner == "rene"
        assert subj.name == "default"

    def test_sub_subject_not_parsed_as_inbox(self) -> None:
        assert parse_agent_subject("agents.hermes.rene.default.heartbeat") is None

    def test_name_equal_to_reserved_subject_rejected(self) -> None:
        # Both `.heartbeat` (§8, protocol-fixed) and `.attachments`
        # (§2 + §5.5, reserved default) MUST NOT be accepted as instance
        # names — otherwise `agents.{a}.{o}.attachments` would parse as a
        # valid inbox and shadow the reserved §5.5 subject.
        assert parse_agent_subject("agents.hermes.rene.heartbeat") is None
        assert parse_agent_subject("agents.hermes.rene.attachments") is None

    def test_wrong_root(self) -> None:
        assert parse_agent_subject("services.hermes.rene.default") is None

    def test_too_few_tokens(self) -> None:
        assert parse_agent_subject("agents.hermes.rene") is None
