"""Unit tests for subject construction and validation per protocol §2 (v0.3)."""

from __future__ import annotations

import base64

import pytest

from synadia_ai.agents import AgentSubject
from synadia_ai.agents.errors import InvalidSubjectToken
from synadia_ai.agents.subjects import (
    VERB_HEARTBEAT,
    VERB_STATUS,
    is_heartbeat_subject,
    parse_agent_subject,
)


class TestConstruction:
    def test_valid_simple_tokens(self) -> None:
        subj = AgentSubject.new(agent="oc", owner="derek", name="summarizer")
        assert subj.prompt == "agents.prompt.oc.derek.summarizer"
        assert subj.heartbeat == "agents.hb.oc.derek.summarizer"
        assert subj.status == "agents.status.oc.derek.summarizer"
        # `inbox` stays as a backwards-name-compat alias of `prompt`.
        assert subj.inbox == subj.prompt

    def test_hyphens_and_underscores_in_name(self) -> None:
        subj = AgentSubject.new(agent="hermes", owner="rene", name="default_worker-1")
        assert subj.prompt == "agents.prompt.hermes.rene.default_worker-1"

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
        assert subj.prompt.startswith(f"agents.prompt.hermes.{expected_owner}.")

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
        assert is_heartbeat_subject("agents.hb.hermes.rene.default") is True

    def test_is_heartbeat_subject_wrong_verb(self) -> None:
        assert is_heartbeat_subject("agents.prompt.hermes.rene.default") is False
        assert is_heartbeat_subject("agents.status.hermes.rene.default") is False

    def test_is_heartbeat_subject_wrong_length(self) -> None:
        assert is_heartbeat_subject("agents.hb.hermes.rene") is False
        assert is_heartbeat_subject("agents.hb.hermes.rene.default.extra") is False

    def test_is_heartbeat_subject_wrong_root(self) -> None:
        assert is_heartbeat_subject("other.hb.hermes.rene.default") is False


class TestParseAgentSubject:
    def test_valid_prompt_subject(self) -> None:
        subj = parse_agent_subject("agents.prompt.hermes.rene.default")
        assert subj is not None
        assert subj.agent == "hermes"
        assert subj.owner == "rene"
        assert subj.name == "default"

    def test_wrong_verb_returns_none(self) -> None:
        # Default `verb=VERB_PROMPT` filter rejects non-prompt subjects.
        assert parse_agent_subject("agents.hb.hermes.rene.default") is None
        assert parse_agent_subject("agents.status.hermes.rene.default") is None

    def test_verb_filter_overrideable(self) -> None:
        subj = parse_agent_subject("agents.hb.hermes.rene.default", verb=VERB_HEARTBEAT)
        assert subj is not None and subj.name == "default"
        subj_status = parse_agent_subject("agents.status.hermes.rene.default", verb=VERB_STATUS)
        assert subj_status is not None and subj_status.name == "default"

    def test_instance_named_after_a_verb_is_fine_under_v03(self) -> None:
        # Verbs and instance names live in different positions now, so an
        # instance literally named `hb` or `heartbeat` no longer collides
        # with the §8 heartbeat subject.
        for instance in ("hb", "heartbeat"):
            subj = parse_agent_subject(f"agents.prompt.hermes.rene.{instance}")
            assert subj is not None and subj.name == instance

    def test_wrong_root(self) -> None:
        assert parse_agent_subject("services.prompt.hermes.rene.default") is None

    def test_too_few_tokens(self) -> None:
        assert parse_agent_subject("agents.prompt.hermes.rene") is None
