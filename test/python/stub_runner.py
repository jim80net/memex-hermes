"""StubRunner — records every dispatch the provider attempts.

Used by tests that assert WHAT the provider tells the runner to do,
without involving a real subprocess. The stub mirrors the public
surface of ``HermesRunner`` (run_subprocess_sync, await_subprocess,
fire_and_forget, shutdown) and records each call.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any


@dataclass
class StubCall:
    surface: str  # "sync" | "async" | "faf"
    event_name: str
    args: dict[str, Any]
    session_id: str | None
    cwd: str | None


@dataclass
class StubRunner:
    """Drop-in stub for ``HermesRunner``.

    Configure ``next_result`` to control what ``run_subprocess_sync`` /
    ``await_subprocess`` return for the next call.
    """

    calls: list[StubCall] = field(default_factory=list)
    next_result: dict[str, Any] = field(default_factory=dict)
    shutdown_called: bool = False
    shutdown_timeout: float | None = None
    raise_on_call: bool = False

    def run_subprocess_sync(
        self,
        event_name: str,
        args: Mapping[str, Any],
        *,
        session_id: str | None = None,
        cwd: str | None = None,
        timeout_s: float | None = None,
    ) -> Mapping[str, Any]:
        if self.raise_on_call:
            raise RuntimeError("stub raised")
        self.calls.append(
            StubCall(
                surface="sync",
                event_name=event_name,
                args=dict(args),
                session_id=session_id,
                cwd=cwd,
            )
        )
        return dict(self.next_result)

    async def await_subprocess(
        self,
        event_name: str,
        args: Mapping[str, Any],
        *,
        session_id: str | None = None,
        cwd: str | None = None,
        timeout_s: float | None = None,
    ) -> Mapping[str, Any]:
        self.calls.append(
            StubCall(
                surface="async",
                event_name=event_name,
                args=dict(args),
                session_id=session_id,
                cwd=cwd,
            )
        )
        return dict(self.next_result)

    def fire_and_forget(
        self,
        event_name: str,
        args: Mapping[str, Any],
        *,
        session_id: str | None = None,
        cwd: str | None = None,
    ) -> None:
        self.calls.append(
            StubCall(
                surface="faf",
                event_name=event_name,
                args=dict(args),
                session_id=session_id,
                cwd=cwd,
            )
        )

    def shutdown(self, timeout_s: float = 5.0) -> None:
        self.shutdown_called = True
        self.shutdown_timeout = timeout_s

    # ---- Test conveniences -----------------------------------------------

    def event_names(self, surface: str | None = None) -> list[str]:
        return [c.event_name for c in self.calls if surface is None or c.surface == surface]

    def reset(self) -> None:
        self.calls.clear()
        self.shutdown_called = False
        self.shutdown_timeout = None
