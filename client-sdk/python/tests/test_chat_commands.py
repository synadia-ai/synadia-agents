"""Unit tests for ``examples/06-chat.py``'s slash-command parser.

The REPL itself is interactive and awkward to drive from pytest; the parser
is factored out as a pure function so the command-classification logic can
be covered at unit-test speed.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from types import ModuleType


def _load_chat_module() -> ModuleType:
    """Import ``examples/06-chat.py`` by path — the filename starts with a
    digit, so a plain ``from examples.06-chat import ...`` doesn't work."""
    path = Path(__file__).resolve().parent.parent / "examples" / "06-chat.py"
    spec = importlib.util.spec_from_file_location("_chat_under_test", path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["_chat_under_test"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def chat() -> ModuleType:
    return _load_chat_module()


@pytest.mark.parametrize(
    ("line", "expected_action", "expected_text"),
    [
        ("", "continue", ""),
        ("   ", "continue", ""),
        ("\t\n", "continue", ""),
        ("hello world", "send", "hello world"),
        ("  hello  ", "send", "hello"),
        ("/quit", "quit", ""),
        ("/q", "quit", ""),
        ("/exit", "quit", ""),
        ("/QUIT", "quit", ""),  # case-insensitive
        ("  /quit  ", "quit", ""),
        ("/clear", "clear", ""),
        ("/help", "help", ""),
        ("/?", "help", ""),
        ("/unknown", "help", ""),  # unknown slash commands fall through to help
        ("/", "help", ""),
    ],
)
def test_parse_input(chat: ModuleType, line: str, expected_action: str, expected_text: str) -> None:
    parsed = chat.parse_input(line)
    assert parsed.action == expected_action
    assert parsed.text == expected_text


def test_slash_prefix_not_swallowed_in_text(chat: ModuleType) -> None:
    """A prompt that happens to contain ``/`` somewhere in the middle is not a slash command."""
    parsed = chat.parse_input("tell me about http://example.com")
    assert parsed.action == "send"
    assert parsed.text == "tell me about http://example.com"
