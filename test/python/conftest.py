"""Shared pytest fixtures.

Adds ``test/python`` to ``sys.path`` so cross-test helpers (``fake_binary``)
can be imported with a flat module name from any test module.
"""

from __future__ import annotations

import stat
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


@pytest.fixture(autouse=True)
def hermetic_binary(
    tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pin ``MEMEX_HERMES_BINARY`` to a harmless ``{}``-emitting fake.

    A runner built with no explicit ``binary_path`` and no cache binary
    now resolves to the shipped ``bin/memex`` wrapper, which would attempt
    a real first-run network download. Unit tests must never touch the
    network, so by default every test points the binary at a fast fake
    that just prints ``{}`` — preserving the prior "default path degrades
    to empty" semantics without the I/O.

    Tests that pass ``binary_path=`` get their own binary (constructor
    override wins over env). Tests that exercise default *resolution*
    (env / cache / wrapper precedence) delete this env var first.
    """
    fake = tmp_path_factory.mktemp("hermetic-bin") / "memex"
    fake.write_text("#!/bin/sh\nprintf '{}'\n", encoding="utf-8")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("MEMEX_HERMES_BINARY", str(fake))
