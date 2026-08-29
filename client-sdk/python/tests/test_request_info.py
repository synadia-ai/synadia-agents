"""``Nats-Request-Info`` parsing (read only under operator-attested mode)."""

from __future__ import annotations

import json

from synadia_ai.agents.identity import (
    NATS_REQUEST_INFO_HEADER,
    RequestInfoStamp,
    parse_request_info,
    read_request_info,
)

ACC = "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRL"
USER = "UAWW24XPLGOX3R3JF4OZEZZ6RUXMB55DSWJCEFFSUDFBCKJD4MSCMQYI"


def test_parse_share_stamp_keeps_acc_and_user_and_ignores_the_rest() -> None:
    # The `share: true` shape on an operator-mode server: `acc`, `user` plus
    # `jwt`, `issuer_key`, `name_tag`, `kind`, `client_type`, `rtt`, `server`.
    value = json.dumps(
        {
            "acc": ACC,
            "user": USER,
            "jwt": "eyJ.eyJ.sig",
            "issuer_key": ACC,
            "name_tag": "bob",
            "kind": "Client",
            "client_type": "nats",
            "rtt": 123456,
            "server": "n1",
        }
    )
    assert parse_request_info(value) == RequestInfoStamp(account=ACC, user=USER)


def test_parse_no_share_stamp_has_acc_only() -> None:
    assert parse_request_info('{"acc":"APP2","rtt":42}') == RequestInfoStamp(account="APP2")
    assert parse_request_info("{}") == RequestInfoStamp()


def test_parse_rejects_what_the_server_would_not_write() -> None:
    assert parse_request_info("{") is None
    assert parse_request_info("[]") is None
    assert parse_request_info('"acc"') is None
    assert parse_request_info('{"acc":1}') is None
    assert parse_request_info('{"acc":null}') is None
    assert parse_request_info('{"acc":"APP","user":["U"]}') is None


def test_parse_has_no_size_cap() -> None:
    # A `share: true` stamp embeds the caller's whole user JWT — a cap would
    # refuse legitimate stamps (PR-T2 decision, byte for byte).
    huge = json.dumps({"acc": ACC, "user": USER, "jwt": "x" * 100_000})
    assert parse_request_info(huge) == RequestInfoStamp(account=ACC, user=USER)


def test_read_absent_malformed_and_present() -> None:
    assert read_request_info(None) == (False, None)
    assert read_request_info({}) == (False, None)
    assert read_request_info({"nats-request-info": '{"acc":"X"}'}) == (False, None)  # case
    assert read_request_info({NATS_REQUEST_INFO_HEADER: "{"}) == (True, None)
    assert read_request_info({NATS_REQUEST_INFO_HEADER: 7}) == (True, None)
    assert read_request_info({NATS_REQUEST_INFO_HEADER: '{"acc":"APP"}'}) == (
        True,
        RequestInfoStamp(account="APP"),
    )
    # Raw multi-value form (unreachable over nats-py, which collapses repeats).
    assert read_request_info({NATS_REQUEST_INFO_HEADER: []}) == (False, None)
    assert read_request_info({NATS_REQUEST_INFO_HEADER: ['{"acc":"APP"}']}) == (
        True,
        RequestInfoStamp(account="APP"),
    )
    assert read_request_info({NATS_REQUEST_INFO_HEADER: ['{"acc":"A"}', '{"acc":"B"}']}) == (
        True,
        None,
    )
