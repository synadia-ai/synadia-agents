"""§5.6: top-level envelope fields the protocol does not define.

The encoder writes an envelope's extra fields next to the protocol's own;
the decoder keeps every field it does not know and exposes them as
:attr:`Envelope.extras`. The TypeScript SDK's ``RequestEnvelope.extras`` is
the same surface.
"""

from __future__ import annotations

import json

from synadia_ai.agents import Envelope, decode, encode
from synadia_ai.agents.envelope import is_envelope_field


def test_extras_are_written_after_the_protocols_fields() -> None:
    env = Envelope(prompt="hi", a=1, nested={"b": [True, None]}, text="x")
    assert encode(env) == b'{"prompt":"hi","a":1,"nested":{"b":[true,null]},"text":"x"}'


def test_every_unknown_field_is_kept_verbatim_in_extras() -> None:
    env = decode(b'{"prompt":"hi","a":1,"obj":{"k":"v"},"nil":null}')
    assert env.extras == {"a": 1, "obj": {"k": "v"}, "nil": None}


def test_a_plain_envelope_has_no_extras() -> None:
    assert decode(b'{"prompt":"hi"}').extras == {}
    assert decode(b"plain text").extras == {}


def test_decode_then_encode_keeps_the_unknown_fields_null_included() -> None:
    original = b'{"prompt":"hi","x_ext":{"id":"7","gone":null},"flag":false,"nil":null}'
    assert encode(decode(original)) == original


def test_an_absent_protocol_field_is_still_left_out() -> None:
    wire = json.loads(encode(Envelope(prompt="hi", attachments=None, extra=None)))
    assert wire == {"prompt": "hi", "extra": None}


def test_the_codec_names_the_fields_it_owns() -> None:
    assert is_envelope_field("prompt")
    assert is_envelope_field("attachments")
    assert not is_envelope_field("anything_else")
