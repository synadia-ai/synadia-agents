"""Host-side classification (plan §6.4 T1) through ``AgentService`` on ``nkey-noaccounts.conf``.

Every request is classified **before** the §6.4 ack: a refused request
yields exactly an error frame and the §9.3 terminator — no ack, no
handler call. The caller side is the real Python client (signed via
``Identity``) or a hand-published request (``_raw_prompt``) for the
malformed / replayed / transplanted rows; the receiver is the SDK's own
``AgentService``. Log lines are asserted through ``caplog`` because the
spec makes "logged, never rejected" part of the ``status`` contract.
"""

from __future__ import annotations

import json
import logging
import time
from typing import TYPE_CHECKING
from unittest.mock import MagicMock

import pytest
from synadia_ai.agents import (
    AgentId,
    Agents,
    ClaimedSender,
    DiscoverFilter,
    Envelope,
    Identity,
    ProtocolError,
    ResponseChunk,
    SenderSignatureRequiredError,
    StatusChunk,
    VerifiedSender,
    build_claim_header,
    format_sender,
    format_sender_timestamp,
    parse_sender_header,
    serialize_sender_header,
    sign_sender_header,
    signer_from_seed,
)

from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from tests.harness.wait import wait_for

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg
    from synadia_ai.agents import Agent, AgentInfo, SenderInfo, StreamMessage
    from synadia_ai.agents.identity import NkeySigner

    from tests.conftest import ConnectNkeyUser, EvidenceFor, NkeyUser
    from tests.harness.nats_server import RunningServer

AGENT = "id-svc"
OWNER = "pytest-classify"
PAYLOAD = b'{"prompt":"hi"}'
IDENTITY_LOGGER = "synadia_ai.agent_service.identity"
SERVICE_LOGGER = "synadia_ai.agent_service.service"
ERROR_FRAMES = 2  # §9 error frame + §9.3 terminator, nothing else


class Started:
    """One ``AgentService`` plus what its handler saw."""

    def __init__(self, service: AgentService) -> None:
        self.service = service
        self.senders: list[SenderInfo | None] = []
        self.resolved: list[AgentInfo | None] = []


async def _start(
    nc: NATSClient,
    session_name: str,
    *,
    signer: NkeySigner | None,
    resolve: bool = False,
    **overrides: object,
) -> Started:
    service = AgentService(
        agent=AGENT,
        owner=OWNER,
        session_name=session_name,
        nc=nc,
        heartbeat_interval_s=1,
        keepalive_interval_s=None,
        identity=ServiceIdentity(signer=signer),
        **overrides,  # type: ignore[arg-type]
    )
    started = Started(service)

    async def handler(envelope: Envelope, stream: PromptStream) -> None:
        started.senders.append(stream.sender)
        if resolve:
            s = stream.sender
            started.resolved.append(await s.resolve() if isinstance(s, VerifiedSender) else None)
        await stream.send(f"echo from {format_sender(stream.sender)}")

    service.on_prompt(handler)
    await service.start()
    return started


async def _discover(nc: NATSClient, session_name: str, identity: Identity | None = None) -> Agent:
    agents = Agents(nc=nc, identity=identity)
    found = await agents.discover(
        timeout=1.0, filter=DiscoverFilter(agent=AGENT, session_name=session_name)
    )
    assert len(found) == 1, f"expected one {AGENT}/{session_name}, got {found!r}"
    return found[0]


async def _drain(stream: AsyncIterator[StreamMessage]) -> list[StreamMessage]:
    return [m async for m in stream]


def _echo(events: list[StreamMessage]) -> str:
    return next(m.text for m in events if isinstance(m, ResponseChunk))


async def _raw_prompt(
    nc: NATSClient, subject: str, payload: bytes, headers: dict[str, str] | None = None
) -> list[Msg]:
    """Publish a request by hand and collect the reply frames up to the terminator."""
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    await nc.publish(subject, payload, reply=inbox, headers=headers)
    out: list[Msg] = []
    while True:
        msg = await sub.next_msg(timeout=3.0)
        out.append(msg)
        if msg.data == b"" and not msg.headers:
            break
    await sub.unsubscribe()
    return out


def _error_code(msgs: list[Msg]) -> str | None:
    return (msgs[0].headers or {}).get("Nats-Service-Error-Code") if msgs else None


def _error_desc(msgs: list[Msg]) -> str | None:
    return (msgs[0].headers or {}).get("Nats-Service-Error") if msgs else None


async def _service_error(
    stream: AsyncIterator[StreamMessage],
) -> int:
    """The `Nats-Service-Error-Code` the SDK surfaces as a ``ProtocolError``."""
    with pytest.raises(ProtocolError, match=r"service error (\d+)") as exc_info:
        await _drain(stream)
    return int(str(exc_info.value).split("service error ")[1].split(":")[0])


@pytest.fixture
def alice_signer(identity_keys: dict[str, NkeyUser]) -> NkeySigner:
    return signer_from_seed(identity_keys["alice"].seed)


@pytest.fixture
def alice_id(identity_keys: dict[str, NkeyUser]) -> AgentId:
    return AgentId.new("$G", identity_keys["alice"].public)


@pytest.fixture
async def alice_pair(
    nats_server_nkey: RunningServer, connect_nkey_user: ConnectNkeyUser
) -> tuple[NATSClient, NATSClient]:
    """(host, caller) — both alice, two connections (the self_id memo is per connection)."""
    return (
        await connect_nkey_user(nats_server_nkey, "alice"),
        await connect_nkey_user(nats_server_nkey, "alice"),
    )


async def test_handler_sees_verified_claimed_or_none(
    alice_pair: tuple[NATSClient, NATSClient],
    alice_signer: NkeySigner,
    alice_id: AgentId,
    evidence_for: EvidenceFor,
) -> None:
    host, caller = alice_pair
    recorder = await evidence_for(caller)
    started = await _start(host, "kinds", signer=alice_signer)
    try:
        signed = Identity(signer=alice_signer, name="signer")
        agent = await _discover(caller, "kinds", signed)
        for i in range(2):
            events = await _drain(agent.prompt(f"hi {i}"))
            assert isinstance(events[0], StatusChunk) and events[0].status == "ack"
            assert _echo(events) == f"echo from {alice_id} (verified user, claimed account)"
        v0, v1 = started.senders
        assert isinstance(v0, VerifiedSender) and isinstance(v1, VerifiedSender)
        assert v0.id == alice_id and v0.name == "signer" and v0.account_attested is False
        assert v0.header.sub == started.service.subject.prompt
        assert v0.header.nonce != v1.header.nonce  # fresh nonces, both served

        # An unsigned claim: the harness sees a ClaimedSender — deliberately no `id`.
        claim_agent = await _discover(caller, "kinds", Identity(name="claimant"))
        events = await _drain(claim_agent.prompt("hi"))
        assert _echo(events) == f"echo from {alice_id} (claimed)"
        claim = started.senders[-1]
        assert isinstance(claim, ClaimedSender) and not hasattr(claim, "id")
        assert claim.claim.user == alice_id.user and claim.name == "claimant"

        # No header at all: served, `sender is None`.
        msgs = await _raw_prompt(caller, started.service.subject.prompt, PAYLOAD)
        assert _error_code(msgs) is None
        assert started.senders[-1] is None
        recorder.write_jsonl("senders.jsonl", [str(s) for s in started.senders])
    finally:
        await started.service.stop()


async def test_signed_endpoint_refuses_claims_and_header_less_requests_before_the_ack(
    alice_pair: tuple[NATSClient, NATSClient], alice_signer: NkeySigner, alice_id: AgentId
) -> None:
    host, caller = alice_pair
    started = await _start(host, "signed", signer=alice_signer, min_sender_trust="signed")
    try:
        subject = started.service.subject.prompt
        claim = serialize_sender_header(build_claim_header(id=alice_id))
        msgs = await _raw_prompt(caller, subject, PAYLOAD, {"Agent-Sender": claim})
        assert len(msgs) == ERROR_FRAMES  # error frame + terminator: no ack preceded it
        assert _error_code(msgs) == "401" and _error_desc(msgs) == "signature required"
        assert msgs[-1].data == b"" and not msgs[-1].headers
        msgs = await _raw_prompt(caller, subject, PAYLOAD)
        assert _error_code(msgs) == "401" and _error_desc(msgs) == "signature required"
        assert started.senders == []

        # The SDK reads the requirement from discovery: no signer → raised at call time.
        with pytest.raises(SenderSignatureRequiredError):
            (await _discover(caller, "signed")).prompt("hi")
        # A signer → served.
        agent = await _discover(caller, "signed", Identity(signer=alice_signer))
        assert _echo(await _drain(agent.prompt("hi"))).startswith(f"echo from {alice_id}")
        assert len(started.senders) == 1
    finally:
        await started.service.stop()


async def test_replay_transplant_stale_malformed_and_unknown_v(
    alice_pair: tuple[NATSClient, NATSClient],
    alice_signer: NkeySigner,
    alice_id: AgentId,
    caplog: pytest.LogCaptureFixture,
) -> None:
    host, caller = alice_pair
    a = await _start(host, "codec-a", signer=alice_signer)
    b = await _start(host, "codec-b", signer=alice_signer)
    try:
        subject = a.service.subject.prompt
        h = await sign_sender_header(signer=alice_signer, id=alice_id, sub=subject, payload=PAYLOAD)
        value = serialize_sender_header(h)
        with caplog.at_level(logging.WARNING, logger=IDENTITY_LOGGER):
            assert (
                _error_code(await _raw_prompt(caller, subject, PAYLOAD, {"Agent-Sender": value}))
                is None
            )
            assert isinstance(a.senders[-1], VerifiedSender)
            # Replay (same nonce, same user) → 401 `sender rejected`, before the ack.
            replay = await _raw_prompt(caller, subject, PAYLOAD, {"Agent-Sender": value})
            assert len(replay) == ERROR_FRAMES
            assert _error_code(replay) == "401" and _error_desc(replay) == "sender rejected"
            assert len(a.senders) == 1
            assert any("already seen" in r.getMessage() for r in caplog.records)
            assert h.nonce is not None
            assert all(h.nonce not in r.getMessage() for r in caplog.records)
            # Transplanted verbatim onto a sibling's subject → 401 there.
            other = b.service.subject.prompt
            assert (
                _error_code(await _raw_prompt(caller, other, PAYLOAD, {"Agent-Sender": value}))
                == "401"
            )
            assert b.senders == []
            # Tampered payload → 401.
            assert (
                _error_code(
                    await _raw_prompt(caller, subject, b'{"prompt":"ho"}', {"Agent-Sender": value})
                )
                == "401"
            )
            # Stale `ts` + fresh nonce → 401, and the nonce is NOT recorded: the same
            # nonce with a fresh `ts` is served afterwards.
            stale = await sign_sender_header(
                signer=alice_signer,
                id=alice_id,
                sub=subject,
                payload=PAYLOAD,
                ts=format_sender_timestamp(time.time() - 120),
            )
            assert stale.nonce is not None
            assert (
                _error_code(
                    await _raw_prompt(
                        caller, subject, PAYLOAD, {"Agent-Sender": serialize_sender_header(stale)}
                    )
                )
                == "401"
            )
            fresh_same_nonce = await sign_sender_header(
                signer=alice_signer, id=alice_id, sub=subject, payload=PAYLOAD, nonce=stale.nonce
            )
            assert (
                _error_code(
                    await _raw_prompt(
                        caller,
                        subject,
                        PAYLOAD,
                        {"Agent-Sender": serialize_sender_header(fresh_same_nonce)},
                    )
                )
                is None
            )
            # Malformed → 400 (sig without sub/ts/nonce; not JSON; bad `v`).
            for bad in (
                "{",
                json.dumps({"v": "1", "account": "$G", "user": alice_id.user}),
                json.dumps({"v": 1, "account": "$G", "user": alice_id.user, "sig": h.sig}),
            ):
                msgs = await _raw_prompt(caller, subject, PAYLOAD, {"Agent-Sender": bad})
                assert len(msgs) == ERROR_FRAMES and _error_code(msgs) == "400"
                assert _error_desc(msgs) == "malformed Agent-Sender header"
            # Unknown `v` → served with no sender.
            v2 = json.dumps({**json.loads(value), "v": 2}, separators=(",", ":"))
            assert (
                _error_code(await _raw_prompt(caller, subject, PAYLOAD, {"Agent-Sender": v2}))
                is None
            )
            assert a.senders[-1] is None
            # Lowercase header name → absent (nats-py preserves header-name case).
            fresh = await sign_sender_header(
                signer=alice_signer, id=alice_id, sub=subject, payload=PAYLOAD
            )
            lower = {"agent-sender": serialize_sender_header(fresh)}
            assert _error_code(await _raw_prompt(caller, subject, PAYLOAD, lower)) is None
            assert a.senders[-1] is None
        refusals = [r for r in caplog.records if "refused on sender identity" in r.getMessage()]
        assert len(refusals) == 7  # replay, transplant, tamper, stale, 3 x malformed
        assert all(r.levelno == logging.WARNING for r in refusals)
    finally:
        await a.service.stop()
        await b.service.stop()


async def test_accept_sender_403_401_500_and_runs_before_the_ack(
    alice_pair: tuple[NATSClient, NATSClient],
    alice_signer: NkeySigner,
    caplog: pytest.LogCaptureFixture,
) -> None:
    host, caller = alice_pair
    seen_by_hook: list[SenderInfo | None] = []
    hook_secret: str | None = None

    def refuse(sender: SenderInfo | None) -> bool:
        seen_by_hook.append(sender)
        return False

    async def explode(sender: SenderInfo | None) -> bool:
        nonlocal hook_secret
        assert isinstance(sender, VerifiedSender)
        hook_secret = sender.header.nonce
        raise RuntimeError(f"sensitive hook detail: {hook_secret}")

    async def accept_async(_sender: SenderInfo | None) -> bool:
        return True

    refusing = await _start(host, "refusing", signer=alice_signer, accept_sender=refuse)
    throwing = await _start(host, "throwing", signer=alice_signer, accept_sender=explode)
    accepting = await _start(host, "accepting", signer=alice_signer, accept_sender=accept_async)
    try:
        signed = Identity(signer=alice_signer)
        with caplog.at_level(logging.WARNING, logger=IDENTITY_LOGGER):
            assert (
                await _service_error((await _discover(caller, "refusing", signed)).prompt("hi"))
                == 403
            )
            assert (
                await _service_error((await _discover(caller, "refusing", Identity())).prompt("hi"))
                == 401
            )
            msgs = await _raw_prompt(caller, refusing.service.subject.prompt, PAYLOAD)
            assert len(msgs) == ERROR_FRAMES  # no ack: the hook ran before it
            assert _error_code(msgs) == "401" and _error_desc(msgs) == "signature required"
        assert [type(s).__name__ if s else None for s in seen_by_hook] == [
            "VerifiedSender",
            "ClaimedSender",
            None,
        ]
        assert refusing.senders == []
        assert sum("refused on sender identity" in r.getMessage() for r in caplog.records) == 3

        with caplog.at_level(logging.ERROR, logger=IDENTITY_LOGGER):
            assert (
                await _service_error((await _discover(caller, "throwing", signed)).prompt("hi"))
                == 500
            )
            msgs = await _raw_prompt(caller, throwing.service.subject.prompt, PAYLOAD)
            assert _error_code(msgs) == "500" and _error_desc(msgs) == "server error"
        assert throwing.senders == []
        assert any(
            r.levelno == logging.ERROR and "accept_sender hook raised" in r.getMessage()
            for r in caplog.records
        )
        assert hook_secret is not None
        assert hook_secret not in caplog.text
        assert "sensitive hook detail" not in caplog.text

        events = await _drain((await _discover(caller, "accepting", signed)).prompt("hi"))
        assert any(isinstance(m, ResponseChunk) for m in events)
        assert len(accepting.senders) == 1
    finally:
        await refusing.service.stop()
        await throwing.service.stop()
        await accepting.service.stop()


async def test_status_is_classified_logged_and_never_rejected(
    alice_pair: tuple[NATSClient, NATSClient],
    alice_signer: NkeySigner,
    alice_id: AgentId,
    caplog: pytest.LogCaptureFixture,
) -> None:
    host, caller = alice_pair
    started = await _start(host, "status", signer=alice_signer)
    status_headers: list[dict[str, str]] = []

    async def spy(msg: Msg) -> None:
        status_headers.append(dict(msg.headers or {}))

    await caller.subscribe(started.service.subject.status, cb=spy)
    await caller.flush()
    try:
        agent = await _discover(caller, "status", Identity(signer=alice_signer, name="probe"))
        with caplog.at_level(logging.DEBUG, logger=SERVICE_LOGGER):
            hb = await agent.status()
        assert hb.instance_id == started.service.instance_id
        assert any(
            r.getMessage() == f"status request on {started.service.subject.status} from "
            f"{alice_id} (verified user, claimed account)"
            for r in caplog.records
        )
        await wait_for(lambda: len(status_headers) == 1, what="the status header spy")
        # A malformed header: still answered, logged as a warning with the code.
        with caplog.at_level(logging.WARNING, logger=IDENTITY_LOGGER):
            reply = await caller.request(
                started.service.subject.status, b"", timeout=2.0, headers={"Agent-Sender": "{"}
            )
            assert "Nats-Service-Error-Code" not in (reply.headers or {})
            assert json.loads(reply.data)["instance_id"] == started.service.instance_id
            assert any(
                "status request" in r.getMessage() and "rejected (400:" in r.getMessage()
                for r in caplog.records
            )
            # A replayed status header: answered, logged; its nonce sits in the set
            # shared with `prompt` — a prompt header reusing it is refused.
            captured = status_headers[0]["Agent-Sender"]
            reply = await caller.request(
                started.service.subject.status, b"", timeout=2.0, headers={"Agent-Sender": captured}
            )
            assert "Nats-Service-Error-Code" not in (reply.headers or {})
            # The early nonce lookup catches it (the `record()` CAS path is only
            # for concurrent requests carrying the same nonce).
            assert any(
                "already seen" in r.getMessage() and "reply sent anyway" in r.getMessage()
                for r in caplog.records
            )
        parsed = parse_sender_header(captured)
        assert parsed is not None and parsed.nonce is not None
        reuse = await sign_sender_header(
            signer=alice_signer,
            id=alice_id,
            sub=started.service.subject.prompt,
            payload=PAYLOAD,
            nonce=parsed.nonce,
        )
        msgs = await _raw_prompt(
            caller,
            started.service.subject.prompt,
            PAYLOAD,
            {"Agent-Sender": serialize_sender_header(reuse)},
        )
        assert _error_code(msgs) == "401"
        assert started.senders == []
    finally:
        await started.service.stop()


async def test_verified_sender_resolve_is_bound_to_the_reverse_lookup(
    alice_pair: tuple[NATSClient, NATSClient], alice_signer: NkeySigner, alice_id: AgentId
) -> None:
    host, caller = alice_pair
    # alice on both ends: the caller's ID resolves to this very service.
    started = await _start(host, "resolving", signer=alice_signer, resolve=True)
    try:
        agent = await _discover(caller, "resolving", Identity(signer=alice_signer))
        await _drain(agent.prompt("hi"))
        assert len(started.resolved) == 1
        info = started.resolved[0]
        assert info is not None
        assert info.identity == alice_id and info.id_sig_verified is True
        assert info.instance_id == started.service.instance_id
        assert info.prompt_endpoint.subject == started.service.subject.prompt
    finally:
        await started.service.stop()


def test_option_validation() -> None:
    base: dict[str, object] = {"agent": AGENT, "owner": OWNER, "session_name": "opts"}
    nc = MagicMock()

    def make(**kw: object) -> AgentService:
        return AgentService(nc=nc, **base, **kw)  # type: ignore[arg-type]

    with pytest.raises(ValueError, match="min_sender_trust"):
        make(min_sender_trust="verified")
    with pytest.raises(ValueError, match="replay_window_s"):
        make(replay_window_s=0)
    with pytest.raises(ValueError, match="resolve_ttl_s"):
        make(resolve_ttl_s=-1)
    assert make(resolve_ttl_s=0).min_sender_trust == "any"
    with pytest.raises(TypeError, match="operator_attested"):
        make(operator_attested="yes")
    assert make(operator_attested=True).operator_attested is True
    with pytest.raises(TypeError, match="ServiceIdentity"):
        make(identity=Identity())  # the caller-side type is not the host's
    with pytest.raises(RuntimeError, match="instance_id"):
        _ = make().instance_id


async def test_start_registers_at_the_server_before_returning(
    alice_pair: tuple[NATSClient, NATSClient], alice_signer: NkeySigner
) -> None:
    """A prompt from another connection right after ``start()`` cannot race the SUBs."""
    host, caller = alice_pair
    for i in range(3):
        started = await _start(host, f"flush-{i}", signer=alice_signer)
        try:
            msgs = await _raw_prompt(caller, started.service.subject.prompt, PAYLOAD)
            assert _error_code(msgs) is None and len(started.senders) == 1
        finally:
            await started.service.stop()
