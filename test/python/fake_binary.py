"""Fake binary fixture helpers shared across runner / provider tests.

We do not patch ``subprocess.Popen`` directly because each test wants a
different stdout / exit code / delay. Instead we write a small Python
script to a tmp_path and point ``MEMEX_HERMES_BINARY`` at it. The
script reads stdin, records the envelope, and writes a configurable
stdout. This matches production: the runner sees a real subprocess and
the test asserts on what stdin actually contained.
"""

from __future__ import annotations

import json
import stat
import sys
from pathlib import Path


def write_fake_binary(
    dest: Path,
    *,
    stdout: str = "{}",
    stderr: str = "",
    exit_code: int = 0,
    delay_seconds: float = 0.0,
    record_to: Path | None = None,
) -> Path:
    """Write a fake-binary script to ``dest`` and return its path.

    The script writes the envelope it received from stdin to
    ``record_to`` (one JSON line per invocation) and echoes the
    configured stdout.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    record_arg = repr(str(record_to)) if record_to is not None else "None"
    script = f"""#!{sys.executable}
import json
import sys
import time

_record = {record_arg}
payload = sys.stdin.read()
if _record:
    try:
        envelope = json.loads(payload) if payload else {{}}
    except Exception:
        envelope = {{"_raw": payload}}
    with open(_record, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({{
            "envelope": envelope,
            "env_MEMEX_HERMES_HOME": __import__("os").environ.get("MEMEX_HERMES_HOME", ""),
        }}) + "\\n")
if {delay_seconds!r} > 0:
    time.sleep({delay_seconds!r})
sys.stdout.write({stdout!r})
sys.stderr.write({stderr!r})
sys.exit({exit_code!r})
"""
    dest.write_text(script, encoding="utf-8")
    dest.chmod(dest.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return dest


def read_envelopes(record_path: Path) -> list[dict[str, object]]:
    if not record_path.exists():
        return []
    out: list[dict[str, object]] = []
    for line in record_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        out.append(json.loads(line))
    return out


def fake_binary_paths(tmp_path: Path) -> tuple[Path, Path]:
    """Return (binary_path, record_path) under ``tmp_path``."""
    binary = tmp_path / "bin" / "memex"
    record = tmp_path / "record.jsonl"
    return binary, record


__all__ = ["fake_binary_paths", "read_envelopes", "write_fake_binary"]
