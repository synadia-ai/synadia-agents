"""Structured logging for the SDK.

Uses stdlib `logging`. Every SDK module obtains its logger via `get_logger(__name__)`;
the root SDK logger name is `natsagent`. Callers configure handlers/levels at their
application level — the SDK does not install handlers or set levels by default.
"""

from __future__ import annotations

import logging

_ROOT = "natsagent"


def get_logger(module_name: str) -> logging.Logger:
    """Return a logger under the `natsagent` root. Pass `__name__` from the caller."""
    if module_name == _ROOT or module_name.startswith(_ROOT + "."):
        return logging.getLogger(module_name)
    short = module_name.rsplit(".", maxsplit=1)[-1]
    return logging.getLogger(f"{_ROOT}.{short}")
