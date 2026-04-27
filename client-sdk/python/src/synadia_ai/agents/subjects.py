"""Subject construction and validation per protocol §2.

Wire layout (v0.3): ``agents.{verb}.{agent}.{owner}.{name}`` where ``verb``
is one of the protocol-reserved verbs ``prompt``, ``heartbeat``, ``status``
(plus ``attachments`` reserved for the future §5.5 endpoint). Verbs and
instance names live in different positions, so an agent literally named
``heartbeat`` no longer collides with the §8 heartbeat subject.

``agent``, ``owner``, and ``name`` are constrained to lowercase alphanumeric
plus hyphens (``agent``) or hyphens and underscores (``owner``, ``name``).
Tokens that would otherwise be invalid NATS subject characters are escaped
internally as base64-url-no-padding — the SDK's "sanitize sensibly"
implementation detail, not a protocol contract.

§2 uses ``agent`` where v0.0.1 of this SDK used ``platform``; the rename
is tracked in CHANGELOG.md under 0.1.0. The verb-first move landed in
0.4.0 (protocol v0.3).
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass

from .errors import InvalidSubjectToken

ROOT = "agents"

# §2 token constraints.
_AGENT_RE = re.compile(r"^[a-z0-9-]+$")
_OWNER_RE = re.compile(r"^[a-z0-9_-]+$")
_NAME_RE = _OWNER_RE

# §2 (v0.3) reserved verbs. ``prompt``/``heartbeat``/``status`` are wired up
# by this SDK; ``attachments`` is reserved for the future §5.5 endpoint.
VERB_PROMPT = "prompt"
VERB_HEARTBEAT = "heartbeat"
VERB_STATUS = "status"
VERB_ATTACHMENTS = "attachments"

RESERVED_VERBS = frozenset({VERB_PROMPT, VERB_HEARTBEAT, VERB_STATUS, VERB_ATTACHMENTS})

# `agents.{verb}.{agent}.{owner}.{name}` — 5 tokens (§2 v0.3).
_SUBJECT_TOKEN_COUNT = 5


@dataclass(frozen=True, slots=True)
class AgentSubject:
    """The three identifying tokens of an agent, already validated/sanitized.

    Construct via :meth:`new` — it enforces §1 constraints and falls back to
    SDK-internal base64 escaping for owner/name tokens that contain characters
    NATS subjects can't carry directly.
    """

    agent: str
    owner: str
    name: str

    @classmethod
    def new(cls, agent: str, owner: str, name: str) -> AgentSubject:
        if not agent:
            raise InvalidSubjectToken("agent must be non-empty")
        if not _AGENT_RE.fullmatch(agent):
            raise InvalidSubjectToken(
                f"agent {agent!r} must be lowercase alphanumeric + hyphens (§2)"
            )
        return cls(
            agent=agent,
            owner=_sanitize(owner, "owner", _OWNER_RE),
            name=_sanitize(name, "name", _NAME_RE),
        )

    @property
    def inbox(self) -> str:
        """Backwards-name-compat alias of :attr:`prompt`."""
        return self.prompt

    @property
    def prompt(self) -> str:
        """The agent's prompt subject (§2)."""
        return f"{ROOT}.{VERB_PROMPT}.{self.agent}.{self.owner}.{self.name}"

    @property
    def heartbeat(self) -> str:
        """The agent's heartbeat subject (§8.1)."""
        return f"{ROOT}.{VERB_HEARTBEAT}.{self.agent}.{self.owner}.{self.name}"

    @property
    def status(self) -> str:
        """The agent's status request/response subject (v0.3 §-TBD)."""
        return f"{ROOT}.{VERB_STATUS}.{self.agent}.{self.owner}.{self.name}"


def _sanitize(token: str, field: str, pattern: re.Pattern[str]) -> str:
    """Validate a token or escape it as base64-url-no-padding when necessary.

    Natural tokens (matching the strict lowercase `pattern`) pass through
    verbatim so subjects stay readable for the common case. Non-conforming
    tokens are base64-url-no-padding encoded — the encoding alphabet
    `[A-Za-z0-9_-]` is always valid inside a NATS subject token, so the
    escape form is guaranteed safe even though it breaks the natural-token
    lowercase convention. This is an SDK implementation detail ("sanitize
    sensibly") — the protocol does not mandate the encoding scheme.
    """
    if not token:
        raise InvalidSubjectToken(f"{field} must be non-empty")
    if pattern.fullmatch(token):
        return token
    return base64.urlsafe_b64encode(token.encode("utf-8")).rstrip(b"=").decode("ascii")


def is_heartbeat_subject(subject: str) -> bool:
    """True iff the subject is of the form `agents.heartbeat.{a}.{o}.{n}`."""
    parts = subject.split(".")
    return len(parts) == _SUBJECT_TOKEN_COUNT and parts[0] == ROOT and parts[1] == VERB_HEARTBEAT


def parse_agent_subject(subject: str, *, verb: str = VERB_PROMPT) -> AgentSubject | None:
    """Parse an `agents.{verb}.{agent}.{owner}.{name}` subject.

    Returns ``None`` when the subject is not the expected verb (default
    ``prompt``), has the wrong root, or fails token validation. Pass a
    different ``verb`` to parse heartbeat / status subjects through the
    same helper.
    """
    parts = subject.split(".")
    if len(parts) != _SUBJECT_TOKEN_COUNT or parts[0] != ROOT or parts[1] != verb:
        return None
    _, _, agent, owner, name = parts
    try:
        return AgentSubject.new(agent=agent, owner=owner, name=name)
    except InvalidSubjectToken:
        return None
