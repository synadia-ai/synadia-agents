"""The package's own export surface.

``__all__`` is what ``from synadia_ai.agents import *`` promises. A name
listed there but never imported into ``__init__`` makes the star import
raise ``AttributeError`` — and the ordinary ``from ... import name`` fails
too, so the guard is worth having for every public name, not just the
tracing ones.
"""

from __future__ import annotations

import synadia_ai.agents as m


def test_every_name_in_all_is_importable() -> None:
    missing = [name for name in m.__all__ if not hasattr(m, name)]
    assert missing == [], f"__all__ lists names that do not exist: {missing}"


def test_star_import_does_not_raise() -> None:
    exec("from synadia_ai.agents import *", {})
