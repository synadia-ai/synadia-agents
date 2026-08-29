"""In-process counterparts for the caller-side identity tests.

The Python host package classifies senders only from PR-P2 on, so these
tests hand-roll the receiving side with the *shared* codec
(``verify_sender``): a prompt responder that classifies every request,
records what it saw and answers §6-shaped chunks (or the wire error the
spec prescribes for a failing classification), a status responder, and
a real ``$SRV.INFO``-registered ``agents`` micro service carrying the
identity metadata. Everything a test asserts about the wire is what the
shared verifier decided over real NATS messages.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from nats.micro import ServiceConfig, add_service
from nats.micro.service import EndpointConfig

from synadia_ai.agents import (
    PROMPT_QUEUE_GROUP,
    SERVICE_NAME,
    STATUS_QUEUE_GROUP,
    AgentId,
    MalformedSenderHeaderError,
    SenderInfo,
    SenderVerificationError,
    VerifiedSender,
    sign_agent_id,
    verify_sender,
)
from synadia_ai.agents.identity import SIGNATURE_REQUIRED_DESCRIPTION

if TYPE_CHECKING:
    from collections.abc import Mapping

    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg
    from nats.micro.request import Request
    from nats.micro.service import Service

    from synadia_ai.agents.identity import NkeySigner


class _MessageLike(Protocol):
    @property
    def subject(self) -> str: ...

    @property
    def data(self) -> bytes: ...

    @property
    def headers(self) -> Mapping[str, str] | None: ...


SERVICE_ERROR_CODE = "Nats-Service-Error-Code"
SERVICE_ERROR = "Nats-Service-Error"
REQUEST_INFO = "Nats-Request-Info"
POSITION_OVERRIDE_HEADER = "X-Test-Position"


@dataclass(slots=True)
class Seen:
    """One request as the fake receiver saw it, with the shared verifier's verdict."""

    subject: str
    data: bytes
    headers: dict[str, str] | None
    sender: SenderInfo | None
    error: Exception | None
    request_info: str | None

    @property
    def header(self) -> str | None:
        return (self.headers or {}).get("Agent-Sender")


@dataclass(slots=True)
class _Classified:
    sender: SenderInfo | None = None
    error: Exception | None = None
    code: int | None = None
    description: str = ""


def _classify(
    msg: _MessageLike,
    *,
    nonces: set[tuple[str, str]],
    account_token_position: int | None,
    replay_window_s: float | None,
    min_sender_trust: str,
) -> _Classified:
    """The receiver-side classification PR-P2 will ship, over the shared codec."""
    out = _Classified()
    position = account_token_position
    override = (msg.headers or {}).get(POSITION_OVERRIDE_HEADER)
    if override is not None:
        position = int(override)
    try:
        out.sender = verify_sender(
            msg,
            "live",
            account_token_position=position,
            replay_window_s=replay_window_s,
            nonce_seen=lambda user, nonce: (user, nonce) in nonces,
        )
        if isinstance(out.sender, VerifiedSender):
            assert out.sender.header.nonce is not None
            nonces.add((out.sender.header.user, out.sender.header.nonce))
        if min_sender_trust == "signed" and not isinstance(out.sender, VerifiedSender):
            raise SenderVerificationError(
                401, SIGNATURE_REQUIRED_DESCRIPTION, "unsigned request on a signed endpoint"
            )
    except MalformedSenderHeaderError as exc:
        out.error, out.code, out.description = exc, 400, "malformed Agent-Sender header"
    except SenderVerificationError as exc:
        out.error, out.code, out.description = exc, exc.code, exc.description
    return out


class FakePromptAgent:
    """A responder on ``subject`` that classifies each request and streams ``chunks``."""

    def __init__(
        self,
        nc: NATSClient,
        subject: str,
        *,
        chunks: tuple[str, ...] = ("ok",),
        account_token_position: int | None = None,
        replay_window_s: float | None = None,
        min_sender_trust: str = "any",
    ) -> None:
        self._nc = nc
        self.subject = subject
        self._chunks = chunks
        self._position = account_token_position
        self._window = replay_window_s
        self._min_sender_trust = min_sender_trust
        self.seen: list[Seen] = []
        self.nonces: set[tuple[str, str]] = set()
        self._sub: object | None = None

    async def start(self) -> FakePromptAgent:
        self._sub = await self._nc.subscribe(self.subject, cb=self._on_msg)
        await self._nc.flush()  # the SUB must be at the server before the first request
        return self

    async def stop(self) -> None:
        if self._sub is not None:
            await self._sub.unsubscribe()  # type: ignore[attr-defined]
            self._sub = None

    async def _on_msg(self, msg: Msg) -> None:
        verdict = _classify(
            msg,
            nonces=self.nonces,
            account_token_position=self._position,
            replay_window_s=self._window,
            min_sender_trust=self._min_sender_trust,
        )
        self.seen.append(
            Seen(
                subject=msg.subject,
                data=msg.data,
                headers=dict(msg.headers) if msg.headers else None,
                sender=verdict.sender,
                error=verdict.error,
                request_info=(msg.headers or {}).get(REQUEST_INFO),
            )
        )
        if verdict.code is not None:
            await self._nc.publish(
                msg.reply,
                b"",
                headers={SERVICE_ERROR_CODE: str(verdict.code), SERVICE_ERROR: verdict.description},
            )
            await self._nc.publish(msg.reply, b"")  # §9.3 terminator
            return
        for text in self._chunks:
            await self._nc.publish(
                msg.reply, json.dumps({"type": "response", "data": text}).encode("utf-8")
            )
        await self._nc.publish(msg.reply, b"")


class FakeStatusAgent:
    """A single-reply responder on ``subject`` answering a §8.3 heartbeat payload."""

    def __init__(
        self,
        nc: NATSClient,
        subject: str,
        *,
        instance_id: str = "fake-status-instance",
        error_code: int | None = None,
        reply: bytes | None = None,
    ) -> None:
        self._nc = nc
        self.subject = subject
        self.instance_id = instance_id
        self._error_code = error_code
        self._reply = reply
        self.seen: list[Seen] = []
        self.nonces: set[tuple[str, str]] = set()
        self._sub: object | None = None

    async def start(self) -> FakeStatusAgent:
        self._sub = await self._nc.subscribe(self.subject, cb=self._on_msg)
        await self._nc.flush()
        return self

    async def stop(self) -> None:
        if self._sub is not None:
            await self._sub.unsubscribe()  # type: ignore[attr-defined]
            self._sub = None

    async def _on_msg(self, msg: Msg) -> None:
        verdict = _classify(
            msg,
            nonces=self.nonces,
            account_token_position=None,
            replay_window_s=None,
            min_sender_trust="any",
        )
        self.seen.append(
            Seen(
                subject=msg.subject,
                data=msg.data,
                headers=dict(msg.headers) if msg.headers else None,
                sender=verdict.sender,
                error=verdict.error,
                request_info=(msg.headers or {}).get(REQUEST_INFO),
            )
        )
        # `status` never rejects on identity grounds: a failing classification is
        # logged (here: recorded) and the reply is sent anyway.
        if self._error_code is not None:
            await self._nc.publish(
                msg.reply,
                b"",
                headers={SERVICE_ERROR_CODE: str(self._error_code), SERVICE_ERROR: "boom"},
            )
            return
        payload = self._reply
        if payload is None:
            payload = json.dumps(
                {
                    "agent": "fake",
                    "owner": "testers",
                    "session": "s",
                    "instance_id": self.instance_id,
                    "ts": "2026-08-29T00:00:00Z",
                    "interval_s": 5,
                }
            ).encode("utf-8")
        await self._nc.publish(msg.reply, payload)


@dataclass(slots=True)
class RegisteredAgent:
    """A real ``agents`` micro service plus what its prompt handler saw."""

    service: Service
    prompt_subject: str
    status_subject: str
    seen: list[Seen] = field(default_factory=list)

    @property
    def instance_id(self) -> str:
        return self.service.id

    async def stop(self) -> None:
        await self.service.stop()


async def register_agent_service(
    nc: NATSClient,
    *,
    agent: str,
    owner: str,
    session_name: str,
    signer: NkeySigner | None = None,
    account: str | None = None,
    min_sender_trust: str | None = "any",
    tamper_id_sig: bool = False,
    max_payload: str = "1MB",
) -> RegisteredAgent:
    """Register a spec-shaped ``agents`` service the way a host SDK would.

    With ``signer`` + ``account`` the metadata carries ``user_nkey``,
    ``account`` and an ``id_sig`` over the prompt subject (tampered when
    asked); ``min_sender_trust=None`` leaves the key out (a 0.3 agent).
    The prompt handler classifies with the shared verifier and echoes one
    chunk; flushes before returning so the SUBs are at the server.
    """
    prompt_subject = f"agents.prompt.{agent}.{owner}.{session_name}"
    status_subject = f"agents.status.{agent}.{owner}.{session_name}"
    metadata = {"agent": agent, "owner": owner, "session": session_name, "protocol_version": "0.3"}
    if signer is not None and account is not None:
        id = AgentId.new(account, signer.public_key)
        id_sig = await sign_agent_id(
            signer=signer, id=id, agent=agent, owner=owner, prompt_subject=prompt_subject
        )
        if tamper_id_sig:
            id_sig = id_sig[:-2] + ("AA" if not id_sig.endswith("AA") else "BB")
        metadata.update({"user_nkey": signer.public_key, "account": account, "id_sig": id_sig})
    registered = RegisteredAgent(
        service=await add_service(
            nc, ServiceConfig(name=SERVICE_NAME, version="0.0.1", metadata=metadata)
        ),
        prompt_subject=prompt_subject,
        status_subject=status_subject,
    )
    nonces: set[tuple[str, str]] = set()

    async def on_prompt(req: Request) -> None:
        verdict = _classify(
            req,  # structural: `Request` carries subject / data / headers like `Msg`
            nonces=nonces,
            account_token_position=None,
            replay_window_s=None,
            min_sender_trust=min_sender_trust or "any",
        )
        registered.seen.append(
            Seen(
                subject=req.subject,
                data=req.data,
                headers=dict(req.headers) if req.headers else None,
                sender=verdict.sender,
                error=verdict.error,
                request_info=(req.headers or {}).get(REQUEST_INFO),
            )
        )
        if verdict.code is not None:
            await req.respond_error(str(verdict.code), verdict.description)
            await req.respond(b"")
            return
        await req.respond(json.dumps({"type": "response", "data": "ok"}).encode("utf-8"))
        await req.respond(b"")

    async def on_status(req: Request) -> None:
        await req.respond(
            json.dumps(
                {
                    "agent": agent,
                    "owner": owner,
                    "session": session_name,
                    "instance_id": registered.service.id,
                    "ts": "2026-08-29T00:00:00Z",
                    "interval_s": 5,
                }
            ).encode("utf-8")
        )

    prompt_metadata = {"max_payload": max_payload, "attachments_ok": "true"}
    if min_sender_trust is not None:
        prompt_metadata["min_sender_trust"] = min_sender_trust
    await registered.service.add_endpoint(
        EndpointConfig(
            name="prompt",
            subject=prompt_subject,
            handler=on_prompt,
            queue_group=PROMPT_QUEUE_GROUP,
            metadata=prompt_metadata,
        )
    )
    await registered.service.add_endpoint(
        EndpointConfig(
            name="status",
            subject=status_subject,
            handler=on_status,
            queue_group=STATUS_QUEUE_GROUP,
        )
    )
    await nc.flush()  # "registered" means the SUBs are at the server (PR-T1 finding)
    return registered
