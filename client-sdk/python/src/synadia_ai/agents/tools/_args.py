"""Parsing a tool call's arguments as the model produced them.

The arguments arrive as the JSON text a chat-completions response carries,
or as that text already parsed. A model gets its arguments wrong now and
then, so every problem comes back as words it can act on
(:class:`ArgsError`), never as an exception. Properties the definitions do
not name are ignored: a host may add parameters of its own and read them
before it hands the call on. The TypeScript SDK's ``tools/args.ts`` is the
same parser.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ArgsError:
    """An argument problem, in words for the model."""

    error: str


@dataclass(frozen=True, slots=True)
class DiscoverArgs:
    agent: str | None = None
    owner: str | None = None
    name: str | None = None


@dataclass(frozen=True, slots=True)
class PromptArgs:
    address: str
    prompt: str
    attachments: tuple[str, ...]
    label: str | None
    wait: bool


@dataclass(frozen=True, slots=True)
class WaitArgs:
    call_ids: tuple[str, ...]
    timeout_ms: int | None


@dataclass(frozen=True, slots=True)
class AnswerArgs:
    call_id: str
    answer: str
    wait: bool | None


@dataclass(frozen=True, slots=True)
class CancelArgs:
    call_ids: tuple[str, ...]


def args_object(tool: str, args: Any) -> dict[str, Any] | ArgsError:
    """The arguments as a dict: ``None`` and empty text count as ``{}``."""
    value = args
    if value is None or value == "":
        return {}
    if isinstance(value, str | bytes):
        try:
            value = json.loads(value)
        except ValueError:
            return ArgsError(f"{tool}: the arguments are not valid JSON")
    if not isinstance(value, dict):
        return ArgsError(f"{tool}: the arguments must be a JSON object")
    return value


def parse_discover_args(args: Any) -> DiscoverArgs | ArgsError:
    fields = args_object("discover_agents", args)
    if isinstance(fields, ArgsError):
        return fields
    out: dict[str, str] = {}
    for key in ("agent", "owner", "name"):
        value = fields.get(key)
        if value is None:
            continue
        if not isinstance(value, str) or value == "":
            return ArgsError(f'discover_agents: "{key}" must be a non-empty string when given')
        out[key] = value
    return DiscoverArgs(**out)


def parse_prompt_args(args: Any) -> PromptArgs | ArgsError:  # noqa: PLR0911
    fields = args_object("prompt_agent", args)
    if isinstance(fields, ArgsError):
        return fields
    address = fields.get("address")
    prompt = fields.get("prompt")
    attachments = fields.get("attachments")
    label = fields.get("label")
    wait = fields.get("wait")
    if not isinstance(address, str) or address == "":
        return ArgsError('prompt_agent: "address" is required, as discover_agents returned it')
    if not isinstance(prompt, str) or prompt == "":
        return ArgsError('prompt_agent: "prompt" is required and must not be empty')
    if attachments is not None and (
        not isinstance(attachments, list)
        or not all(isinstance(p, str) and p != "" for p in attachments)
    ):
        return ArgsError('prompt_agent: "attachments" must be a list of file paths')
    if label is not None and (not isinstance(label, str) or label == ""):
        return ArgsError('prompt_agent: "label" must be a non-empty string when given')
    if wait is not None and not isinstance(wait, bool):
        return ArgsError('prompt_agent: "wait" must be true or false')
    return PromptArgs(
        address=address,
        prompt=prompt,
        attachments=tuple(attachments or ()),
        label=label,
        wait=True if wait is None else wait,
    )


def parse_wait_args(args: Any) -> WaitArgs | ArgsError:
    fields = args_object("wait_agent", args)
    if isinstance(fields, ArgsError):
        return fields
    call_ids = _call_ids("wait_agent", fields.get("call_ids"))
    if isinstance(call_ids, ArgsError):
        return call_ids
    timeout_ms = fields.get("timeout_ms")
    if timeout_ms is None:
        return WaitArgs(call_ids=call_ids, timeout_ms=None)
    # JSON has one number type: 5.0 is a whole number, 1.5 is not.
    if (
        isinstance(timeout_ms, bool)
        or not isinstance(timeout_ms, int | float)
        or timeout_ms < 0
        or timeout_ms != int(timeout_ms)
    ):
        return ArgsError(
            'wait_agent: "timeout_ms" must be a whole number of milliseconds, 0 or more'
        )
    return WaitArgs(call_ids=call_ids, timeout_ms=int(timeout_ms))


def parse_answer_args(args: Any) -> AnswerArgs | ArgsError:
    fields = args_object("answer_agent", args)
    if isinstance(fields, ArgsError):
        return fields
    call_id = fields.get("call_id")
    answer = fields.get("answer")
    wait = fields.get("wait")
    if not isinstance(call_id, str) or call_id == "":
        return ArgsError('answer_agent: "call_id" is required, as it came with the question')
    if not isinstance(answer, str) or answer == "":
        return ArgsError('answer_agent: "answer" is required and must not be empty')
    if wait is not None and not isinstance(wait, bool):
        return ArgsError('answer_agent: "wait" must be true or false')
    return AnswerArgs(call_id=call_id, answer=answer, wait=wait)


def parse_cancel_args(args: Any) -> CancelArgs | ArgsError:
    fields = args_object("cancel_agent", args)
    if isinstance(fields, ArgsError):
        return fields
    call_ids = _call_ids("cancel_agent", fields.get("call_ids"))
    if isinstance(call_ids, ArgsError):
        return call_ids
    return CancelArgs(call_ids=call_ids)


def _call_ids(tool: str, value: Any) -> tuple[str, ...] | ArgsError:
    """``call_ids``: a non-empty list of non-empty strings, duplicates removed, order kept."""
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(i, str) and i != "" for i in value)
    ):
        return ArgsError(f'{tool}: "call_ids" must be a non-empty list of call_id strings')
    return tuple(dict.fromkeys(value))
