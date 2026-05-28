"""§8.9 / G1 — no-Python-engine invariant.

The ``memex_hermes/`` source tree (excluding ``test/`` and ``spike/``)
must contain no imports of embedding / ML libraries owned by the
binary, and no ``subprocess`` argv starting with ``git``. Engine
work is the binary's job.
"""

from __future__ import annotations

import re
from pathlib import Path

# Forbidden import patterns. We match both `import X` and `from X import ...`.
_FORBIDDEN_IMPORT_NAMES = (
    "transformers",
    "onnxruntime",
    "sentence_transformers",
    "numpy",
    "scipy",
    "sklearn",
    "torch",
    "tensorflow",
)


def _package_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "memex_hermes"


def _python_sources() -> list[Path]:
    return sorted(_package_dir().rglob("*.py"))


def test_no_engine_imports() -> None:
    sources = _python_sources()
    assert sources, "expected memex_hermes/*.py sources"
    patterns = [
        re.compile(rf"\b(?:import\s+{name}|from\s+{name})\b")
        for name in _FORBIDDEN_IMPORT_NAMES
    ]
    for src in sources:
        text = src.read_text(encoding="utf-8")
        for pattern, name in zip(patterns, _FORBIDDEN_IMPORT_NAMES, strict=True):
            assert not pattern.search(text), (
                f"{src.relative_to(_package_dir().parent)} contains forbidden import: {name}"
            )


def test_no_git_subprocess_invocation() -> None:
    sources = _python_sources()
    git_re = re.compile(r"""subprocess\.\w+\(\s*\[?\s*["']git["']""")
    Popen_re = re.compile(r"""Popen\(\s*\[?\s*["']git["']""")
    run_re = re.compile(r"""\.run\(\s*\[?\s*["']git["']""")
    for src in sources:
        text = src.read_text(encoding="utf-8")
        assert not git_re.search(text), f"{src.name} subprocess argv starts with 'git'"
        assert not Popen_re.search(text), f"{src.name} Popen argv starts with 'git'"
        assert not run_re.search(text), f"{src.name} .run argv starts with 'git'"
