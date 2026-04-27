"""Subject construction and validation per protocol §2.

The subject hierarchy is ``agents.{agent}.{owner}.{name}`` with well-known
sub-subjects ``.heartbeat`` and ``.attachments`` (future endpoint, §5.5).
``agent``, ``owner``, and ``name`` are constrained to lowercase alphanumeric
plus hyphens (``agent``) or hyphens and underscores (``owner``, ``name``).
Tokens that would otherwise be invalid NATS subject characters are escaped
internally as base64-url-no-padding — the SDK's "sanitize sensibly"
implementation detail, not a protocol contract.

§2 uses ``agent`` where v0.0.1 of this SDK used ``platform``; the rename
is tracked in CHANGELOG.md under 0.1.0.
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

# Sub-subjects reserved by the protocol (§2). `.heartbeat` is protocol-fixed
# (§8); `.attachments` is the reserved default subject for the future §5.5
# endpoint — no code publishes or subscribes to it today, but the token is
# kept out of instance-name slots so `agents.{a}.{o}.attachments` can't be
# registered as an inbox and shadow the reserved subject.
SUB_HEARTBEAT = "heartbeat"
SUB_ATTACHMENTS = "attachments"

RESERVED_SUB_SUBJECTS = frozenset({SUB_HEARTBEAT, SUB_ATTACHMENTS})

# `agents.{agent}.{owner}.{name}` — 4 tokens. Add one for a sub-subject like `.heartbeat`.
_INBOX_TOKEN_COUNT = 4
_INBOX_WITH_SUB_TOKEN_COUNT = 5


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
        """The agent's prompt inbox subject."""
        return f"{ROOT}.{self.agent}.{self.owner}.{self.name}"

    @property
    def heartbeat(self) -> str:
        return f"{self.inbox}.{SUB_HEARTBEAT}"


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
    """True iff the subject is of the form `agents.{p}.{o}.{n}.heartbeat`."""
    parts = subject.split(".")
    return (
        len(parts) == _INBOX_WITH_SUB_TOKEN_COUNT
        and parts[0] == ROOT
        and parts[-1] == SUB_HEARTBEAT
    )


def parse_agent_subject(subject: str) -> AgentSubject | None:
    """Parse an `agents.{agent}.{owner}.{name}` inbox subject.

    Returns `None` if the subject is not an inbox (wrong length, wrong root,
    or points at a sub-subject like `.heartbeat`). Strict parsing: callers
    that want to route heartbeat subjects should use the dedicated helpers.
    """
    parts = subject.split(".")
    if len(parts) != _INBOX_TOKEN_COUNT or parts[0] != ROOT:
        return None
    _, agent, owner, name = parts
    if name in RESERVED_SUB_SUBJECTS:
        return None
    try:
        return AgentSubject.new(agent=agent, owner=owner, name=name)
    except InvalidSubjectToken:
        return None
