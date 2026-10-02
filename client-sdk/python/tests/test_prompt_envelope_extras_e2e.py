"""§5.6: an envelope passed to :meth:`Agent.prompt` goes out with its extra fields.

A relay that forwards the envelope it received preserves the top-level
fields the protocol does not define. Prompt interceptors see them as
``ctx.envelope_extras``, read-only; a field an interceptor adds replaces
one of the same name, as between interceptors, and a field the envelope
defines is still refused. The receiver is a responder on a real NATS
server that records each request's bytes as they arrived.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping
from types import MappingProxyType
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio

from synadia_ai.agents import (
    Agent,
    AgentInfo,
    Attachment,
    EndpointInfo,
    Envelope,
    NatsAgentError,
    PayloadTooLargeError,
    PromptExtras,
    PromptInterceptorContext,
    ResponseChunk,
    StreamMessage,
    decode,
)
from tests.harness.fake_agent import FakePromptAgent

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.evidence import EvidenceRecorder

PROMPT_SUBJECT = "agents.prompt.test-agent.pytest.extras"


def _info(*, max_payload_bytes: int | None = None) -> AgentInfo:
    """A hand-built record (the test owns both ends; no ``$SRV.INFO`` round trip)."""
    prompt = EndpointInfo(
        name="prompt",
        subject=PROMPT_SUBJECT,
        queue_group="agents",
        metadata=MappingProxyType({}),
        max_payload_bytes=max_payload_bytes,
        attachments_ok=True,
    )
    return AgentInfo(
        instance_id="test-instance",
        agent="test-agent",
        owner="pytest",
        session_name="extras",
        protocol_version="0.3",
        description="",
        version="0.0.0",
        metadata=MappingProxyType({"agent": "test-agent", "owner": "pytest"}),
        endpoints=(prompt,),
        prompt_endpoint=prompt,
    )


@pytest_asyncio.fixture
async def receiver(nc: NATSClient) -> AsyncIterator[FakePromptAgent]:
    fake = await FakePromptAgent(nc, PROMPT_SUBJECT).start()
    try:
        yield fake
    finally:
        await fake.stop()


async def _drain(stream: AsyncIterator[StreamMessage]) -> None:
    texts = [m.text async for m in stream if isinstance(m, ResponseChunk)]
    assert texts == ["ok"]


def _record(evidence: EvidenceRecorder, receiver: FakePromptAgent) -> None:
    evidence.write_jsonl("received.jsonl", [json.loads(seen.data) for seen in receiver.seen])


class _Adding:
    """Records the context each prompt shows it and adds ``fields``."""

    def __init__(self, fields: Mapping[str, object] | None = None) -> None:
        self.fields = fields
        self.seen: list[PromptInterceptorContext] = []

    async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
        self.seen.append(ctx)
        return PromptExtras(fields=self.fields) if self.fields is not None else None


async def test_relaying_a_received_envelope_sends_its_bytes_unchanged(
    nc: NATSClient, receiver: FakePromptAgent, evidence: EvidenceRecorder
) -> None:
    received = (
        b'{"prompt":"hi","attachments":[{"filename":"a.txt","content":"aGk="}],'
        b'"x_ext":{"id":"7","gone":null},"flag":false,"nil":null}'
    )
    await _drain(Agent(nc, _info()).prompt(decode(received)))
    _record(evidence, receiver)
    assert [seen.data for seen in receiver.seen] == [received]


async def test_attachments_passed_alongside_join_the_envelopes_and_its_extras_stay(
    nc: NATSClient, receiver: FakePromptAgent, evidence: EvidenceRecorder
) -> None:
    envelope = Envelope(prompt="hi", attachments=[Attachment.from_bytes("a.txt", b"a")], x=1)
    await _drain(
        Agent(nc, _info()).prompt(envelope, attachments=[Attachment.from_bytes("b.txt", b"b")])
    )
    _record(evidence, receiver)
    assert receiver.seen[0].data == (
        b'{"prompt":"hi","attachments":[{"filename":"a.txt","content":"YQ=="},'
        b'{"filename":"b.txt","content":"Yg=="}],"x":1}'
    )


async def test_an_interceptors_field_replaces_the_envelopes_and_the_rest_go_out(
    nc: NATSClient, receiver: FakePromptAgent, evidence: EvidenceRecorder
) -> None:
    first = _Adding({"shared": "first", "own": 1})
    second = _Adding({"shared": "second"})
    agent = Agent(nc, _info(), interceptors=[first, second])
    await _drain(agent.prompt(Envelope(prompt="hi", shared="caller", kept={"k": [1, None]})))
    _record(evidence, receiver)
    assert receiver.seen[0].data == (
        b'{"prompt":"hi","shared":"second","kept":{"k":[1,null]},"own":1}'
    )
    # Each sees what the caller's envelope carries, never another interceptor's fields.
    for interceptor in (first, second):
        assert interceptor.seen[0].envelope_extras == {"shared": "caller", "kept": {"k": [1, None]}}


async def test_the_envelope_extras_an_interceptor_sees_are_a_read_only_copy(
    nc: NATSClient, receiver: FakePromptAgent, evidence: EvidenceRecorder
) -> None:
    refused: list[bool] = []

    class Meddling:
        async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
            try:
                ctx.envelope_extras["kept"] = "replaced"  # type: ignore[index]
                refused.append(False)
            except TypeError:
                refused.append(True)
            nested = ctx.envelope_extras["kept"]
            assert isinstance(nested, dict)
            nested["k"] = "changed"
            # A field of its own, so the envelope is encoded again at publish time.
            return PromptExtras(fields={"own": 1})

    envelope = Envelope(prompt="hi", kept={"k": "caller"})
    await _drain(Agent(nc, _info(), interceptors=[Meddling()]).prompt(envelope))
    _record(evidence, receiver)
    assert refused == [True]
    assert receiver.seen[0].data == b'{"prompt":"hi","kept":{"k":"caller"},"own":1}'
    assert envelope.extras == {"kept": {"k": "caller"}}


async def test_a_text_prompt_shows_no_envelope_extras(
    nc: NATSClient, receiver: FakePromptAgent, evidence: EvidenceRecorder
) -> None:
    seeing = _Adding()
    await _drain(Agent(nc, _info(), interceptors=[seeing]).prompt("hi"))
    _record(evidence, receiver)
    assert seeing.seen[0].envelope_extras == {}
    assert receiver.seen[0].data == b'{"prompt":"hi"}'


async def test_an_interceptor_setting_a_protocol_field_is_still_refused(
    nc: NATSClient, receiver: FakePromptAgent
) -> None:
    agent = Agent(nc, _info(), interceptors=[_Adding({"attachments": []})])
    with pytest.raises(NatsAgentError, match="envelope field `attachments` is not an extra"):
        await _drain(agent.prompt(Envelope(prompt="hi", x=1)))
    await nc.flush()
    assert receiver.seen == []


async def test_an_envelopes_extras_count_toward_max_payload(nc: NATSClient) -> None:
    agent = Agent(nc, _info(max_payload_bytes=64))
    await agent.prompt(Envelope(prompt="hi")).aclose()  # type: ignore[attr-defined]
    with pytest.raises(PayloadTooLargeError):
        agent.prompt(Envelope(prompt="hi", padding="x" * 64))
