"""Subprocess runner for the ``memex-hermes`` binary.

The runner is the only place that knows about the binary on disk. Two
surfaces:

* ``await_subprocess(event_name, args, ...)`` — synchronous-style call
  dispatched off the Hermes event loop via ``asyncio.to_thread``. Used
  for events whose result the caller needs to consume (``prefetch``,
  ``is_available``, ``system_prompt_block``, ``handle_tool_call``,
  ``on_pre_compress``, ``on_session_end``).

* ``fire_and_forget(event_name, args, ...)`` — schedules the
  invocation on an internal daemon thread backed by a bounded
  ``queue.Queue``. The provider returns control immediately; the
  binary executes asynchronously. Used for ``sync_turn``,
  ``queue_prefetch``, ``on_memory_write``, ``on_session_switch``,
  ``Hermes.shutdown``. Per F8 + the hermes-memory-provider
  daemon-thread-queue-overflow Scenario, full-queue submissions drop
  the oldest pending entry and emit a warning.

Failure modes (per the hermes-memory-provider Requirement
"Provider degrades gracefully when the binary is unavailable"):

* Binary missing -> the call returns an empty mapping and an install
  hint is logged at most once per process.
* Non-zero exit -> stderr logged; an empty mapping is returned.
* Invalid JSON on stdout -> warning logged; empty mapping returned.
* Per-event timeout -> subprocess killed; warning logged; empty
  mapping returned.

The provider applies the final per-method safe-default mapping (empty
string for ``prefetch``, ``False`` for ``is_available``, error JSON
for tool calls); the runner stays generic.

`Any` appears here only at the JSON-parse boundary where the binary's
stdout is untyped at language level; the provider narrows the parsed
shape via the per-event ``TypedDict`` in ``envelope.py``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import subprocess
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any, Final

from memex_hermes.envelope import HermesEventName, HermesHookInput

logger = logging.getLogger("memex_hermes.runner")

ENV_MEMEX_HOME: Final = "MEMEX_HERMES_HOME"
ENV_MEMEX_BINARY: Final = "MEMEX_HERMES_BINARY"

# Per-event timeouts (seconds). on_session_end legitimately runs longer
# because the binary may extract learnings or push to a sync repo before
# returning. Everything else is interactive.
_DEFAULT_TIMEOUT_S: Final[float] = 10.0
_TIMEOUTS_BY_EVENT: Final[Mapping[str, float]] = {
    "Hermes.prefetch": 10.0,
    "Hermes.queue-prefetch": 10.0,
    "Hermes.session-end": 30.0,
    "Hermes.pre-compress": 30.0,
    "Hermes.session-switch": 5.0,
    "Hermes.shutdown": 5.0,
    "Hermes.health": 5.0,
    "Hermes.init": 10.0,
    "Hermes.system-prompt": 10.0,
    "Hermes.sync-turn": 10.0,
    "Hermes.memory-write": 10.0,
    "Hermes.tool-search": 15.0,
    "Hermes.tool-remember": 15.0,
    "Hermes.tool-recall": 15.0,
}

# Bounded queue capacity for fire-and-forget. Per the queue-overflow
# Scenario: at saturation the oldest entry is dropped to make room.
_FAF_QUEUE_CAPACITY: Final[int] = 128

# Default shutdown drain bound (seconds). Per the shutdown Requirement.
_DEFAULT_SHUTDOWN_TIMEOUT_S: Final[float] = 5.0


def _packaged_wrapper() -> Path | None:
    """Locate the shipped ``bin/memex`` wrapper, or None if absent.

    Two layouts, probed in order (mirrors ``install.py``'s plugin.yaml
    resolution):

    * Wheel install: hatch's ``force-include`` maps ``bin`` ->
      ``memex_hermes/bin``, so the wrapper is at ``<pkg>/bin/memex``.
    * Editable / source checkout: ``bin/`` lives at the repo root,
      i.e. the parent of the package directory (``<pkg>/../bin/memex``).

    The wrapper is a ``/bin/sh`` script that execs the prebuilt binary
    (downloading it on first run) and emits ``{}`` if it cannot, so the
    runner degrades gracefully either way.
    """
    try:
        pkg_root = Path(str(resources.files("memex_hermes")))
    except (ModuleNotFoundError, TypeError, OSError):
        return None
    for candidate in (pkg_root / "bin" / "memex", pkg_root.parent / "bin" / "memex"):
        if candidate.is_file():
            return candidate
    return None


@dataclass(frozen=True)
class _FAFJob:
    event_name: HermesEventName
    envelope: HermesHookInput
    enqueued_at: float


class HermesRunner:
    """Spawns and manages the ``memex-hermes`` binary subprocess.

    One runner instance per provider. The internal worker thread is
    started lazily on the first ``fire_and_forget`` call and lives for
    the provider's lifetime; ``shutdown`` drains it within bound.
    """

    def __init__(
        self,
        hermes_home: Path,
        *,
        binary_path: Path | None = None,
        queue_capacity: int = _FAF_QUEUE_CAPACITY,
    ) -> None:
        self._hermes_home: Path = hermes_home
        self._binary_override: Path | None = binary_path
        self._queue: queue.Queue[_FAFJob] = queue.Queue(maxsize=queue_capacity)
        self._worker: threading.Thread | None = None
        self._worker_started: threading.Event = threading.Event()
        # Each worker owns the stop event it was created with (set on the
        # instance only for ``shutdown`` to reach the live worker). A
        # re-armed worker gets a fresh event, so a prior ``shutdown`` can
        # never stop a later worker. See ``shutdown`` / ``_worker_loop``.
        self._worker_stop: threading.Event | None = None
        self._worker_lock: threading.Lock = threading.Lock()
        self._inflight: int = 0
        self._inflight_lock: threading.Lock = threading.Lock()
        self._inflight_drained: threading.Event = threading.Event()
        self._inflight_drained.set()  # idle by default
        self._install_hint_emitted: bool = False
        self._install_hint_lock: threading.Lock = threading.Lock()

    # ---- Public surfaces ------------------------------------------------

    async def await_subprocess(
        self,
        event_name: HermesEventName,
        args: Mapping[str, Any],
        *,
        session_id: str | None = None,
        cwd: str | None = None,
        timeout_s: float | None = None,
    ) -> Mapping[str, Any]:
        """Run the binary once and return the parsed stdout JSON.

        Dispatched onto a worker thread via ``asyncio.to_thread`` so
        the agent event loop is never blocked. On any failure mode a
        safe empty mapping is returned; the provider chooses the
        per-method final default.
        """
        envelope = self._build_envelope(event_name, args, session_id, cwd)
        effective_timeout = self._effective_timeout(event_name, timeout_s)
        return await asyncio.to_thread(
            self._run_blocking, event_name, envelope, effective_timeout
        )

    def run_subprocess_sync(
        self,
        event_name: HermesEventName,
        args: Mapping[str, Any],
        *,
        session_id: str | None = None,
        cwd: str | None = None,
        timeout_s: float | None = None,
    ) -> Mapping[str, Any]:
        """Synchronous sibling of ``await_subprocess``.

        The verified Hermes v0.14.0 ABC declares every provider method
        synchronously, so the provider's lifecycle methods need a sync
        path. Internally this still hops to a worker thread so a future
        async Hermes host can drive the same code via ``asyncio.run``
        / ``loop.run_in_executor`` without re-architecture.
        """
        envelope = self._build_envelope(event_name, args, session_id, cwd)
        effective_timeout = self._effective_timeout(event_name, timeout_s)
        result_box: dict[str, Mapping[str, Any]] = {}

        def _runner_thread() -> None:
            result_box["result"] = self._run_blocking(event_name, envelope, effective_timeout)

        thread = threading.Thread(target=_runner_thread, daemon=True)
        thread.start()
        # The worker thread enforces the per-event timeout; we wait one
        # extra second for cleanup before treating it as a hung worker.
        thread.join(timeout=effective_timeout + 1.0)
        if thread.is_alive():
            logger.warning(
                "Sync worker for %s did not finish within %.1fs; returning empty",
                event_name,
                effective_timeout + 1.0,
            )
            return {}
        return result_box.get("result", {})

    def fire_and_forget(
        self,
        event_name: HermesEventName,
        args: Mapping[str, Any],
        *,
        session_id: str | None = None,
        cwd: str | None = None,
    ) -> None:
        """Enqueue a binary invocation for the daemon worker.

        Returns immediately; the work happens on the daemon thread.
        On full queue the oldest pending job is dropped to make room,
        and a warning is logged identifying the dropped action.
        """
        envelope = self._build_envelope(event_name, args, session_id, cwd)
        job = _FAFJob(event_name=event_name, envelope=envelope, enqueued_at=time.monotonic())
        self._ensure_worker_running()
        self._enqueue_with_drop_oldest(job)

    def shutdown(self, timeout_s: float = _DEFAULT_SHUTDOWN_TIMEOUT_S) -> None:
        """Drain the fire-and-forget queue within ``timeout_s`` seconds.

        Per the shutdown Requirement (hermes-memory-provider):

        * Waits for in-flight + pending FAF jobs to complete.
        * If still pending after the bound, emits a warning identifying
          the canceled action and returns. The worker thread is a
          daemon so the runtime tears it down on process exit.

        The runner is left REUSABLE: this drains and stops the current
        worker, then re-arms so the next ``fire_and_forget`` starts a
        fresh worker. This is required by ``on_session_switch(reset=True)``,
        which drains to flush per-session buffers and then keeps using the
        same runner. Because each worker owns its own stop event, a worker
        re-armed after this call can never be stopped by this ``shutdown``.
        """
        worker = self._worker
        stop = self._worker_stop
        if worker is None or stop is None:
            return
        stop.set()
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            with self._inflight_lock:
                queued_empty = self._queue.empty()
                idle = self._inflight == 0
            if queued_empty and idle:
                break
            # Wait briefly; the worker drains the queue itself.
            time.sleep(0.01)

        # Final check: anything left after deadline is canceled.
        remaining: list[_FAFJob] = []
        try:
            while True:
                remaining.append(self._queue.get_nowait())
                self._queue.task_done()
        except queue.Empty:
            pass

        for job in remaining:
            logger.warning(
                "shutdown: canceled pending %s after %.1fs drain bound",
                job.event_name,
                timeout_s,
            )
        with self._inflight_lock:
            still_inflight = self._inflight
        if still_inflight:
            logger.warning(
                "shutdown: %d in-flight binary invocation(s) exceeded the %.1fs drain bound",
                still_inflight,
                timeout_s,
            )

        # Re-arm. Join the stopped worker (bounded) so it is gone before we
        # drop the reference, then clear the started latch so the next
        # ``fire_and_forget`` spins up a fresh worker with a fresh stop
        # event. A long in-flight job that outlived the drain bound keeps
        # the old worker alive, but it watches only its OWN (set) stop
        # event and exits on its own; a re-armed worker is unaffected.
        worker.join(timeout=min(timeout_s, 0.5))
        self._worker = None
        self._worker_stop = None
        self._worker_started.clear()

    # ---- Internal: envelope, dispatch, blocking exec --------------------

    def _effective_timeout(
        self, event_name: HermesEventName, override: float | None
    ) -> float:
        if override is not None:
            return override
        return _TIMEOUTS_BY_EVENT.get(event_name, _DEFAULT_TIMEOUT_S)

    def _build_envelope(
        self,
        event_name: HermesEventName,
        args: Mapping[str, Any],
        session_id: str | None,
        cwd: str | None,
    ) -> HermesHookInput:
        envelope: HermesHookInput = {
            "hook_event_name": event_name,
            "args": args,
        }
        if session_id:
            envelope["session_id"] = session_id
        if cwd:
            envelope["cwd"] = cwd
        return envelope

    def _resolve_binary(self) -> Path:
        """Resolve the binary the runner execs, in priority order.

        1. Constructor ``binary_path`` override (tests).
        2. ``MEMEX_HERMES_BINARY`` env var (operator / E2E override).
        3. ``$HERMES_HOME/cache/memex/bin/memex`` IF it exists — the
           §9 dist layout / a manual install.
        4. The shipped ``bin/memex`` wrapper packaged with the wheel
           (or at the source-checkout repo root). The wrapper execs a
           prebuilt binary or self-installs it on first run.
        5. Fallback to the cache path (which does not exist) so the
           FileNotFoundError path emits an install hint naming the
           conventional location.

        Prior to step 3/4 the default resolved to the cache path that
        *nothing in the install flow populates*, so a real install
        silently degraded to a no-op on every binary call.
        """
        if self._binary_override is not None:
            return self._binary_override
        env_override = os.environ.get(ENV_MEMEX_BINARY)
        if env_override:
            return Path(env_override)
        cache_binary = self._hermes_home / "cache" / "memex" / "bin" / "memex"
        if cache_binary.exists():
            return cache_binary
        wrapper = _packaged_wrapper()
        if wrapper is not None:
            return wrapper
        return cache_binary

    def _subprocess_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env[ENV_MEMEX_HOME] = str(self._hermes_home)
        return env

    def _run_blocking(
        self,
        event_name: HermesEventName,
        envelope: HermesHookInput,
        timeout_s: float,
    ) -> Mapping[str, Any]:
        """Execute the binary once. NEVER raises; safe defaults on error."""
        self._mark_inflight_start()
        try:
            return self._run_blocking_inner(event_name, envelope, timeout_s)
        finally:
            self._mark_inflight_end()

    def _run_blocking_inner(
        self,
        event_name: HermesEventName,
        envelope: HermesHookInput,
        timeout_s: float,
    ) -> Mapping[str, Any]:
        binary = self._resolve_binary()
        payload = json.dumps(envelope)
        try:
            proc = subprocess.Popen(
                [str(binary)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=self._subprocess_env(),
                text=True,
            )
        except FileNotFoundError:
            self._emit_install_hint(binary)
            return {}
        except OSError as exc:
            logger.warning("Failed to spawn %s for %s: %s", binary, event_name, exc)
            return {}

        try:
            stdout, stderr = proc.communicate(input=payload, timeout=timeout_s)
        except subprocess.TimeoutExpired:
            logger.warning(
                "Timeout (%.1fs) waiting on %s for %s; killing subprocess",
                timeout_s,
                binary,
                event_name,
            )
            proc.kill()
            try:
                proc.communicate(timeout=1.0)
            except subprocess.TimeoutExpired:
                pass
            return {}

        if proc.returncode != 0:
            logger.warning(
                "%s exited with status %d for %s; stderr=%s",
                binary,
                proc.returncode,
                event_name,
                (stderr or "").strip(),
            )
            return {}

        if not stdout.strip():
            return {}

        try:
            parsed: Any = json.loads(stdout)
        except json.JSONDecodeError as exc:
            logger.warning(
                "Invalid JSON from %s for %s: %s; stdout=%r",
                binary,
                event_name,
                exc,
                stdout[:200],
            )
            return {}

        if not isinstance(parsed, Mapping):
            logger.warning(
                "Unexpected non-mapping JSON from %s for %s: %r",
                binary,
                event_name,
                type(parsed).__name__,
            )
            return {}
        return parsed

    def _emit_install_hint(self, binary: Path) -> None:
        with self._install_hint_lock:
            if self._install_hint_emitted:
                return
            self._install_hint_emitted = True
        logger.warning(
            "memex-hermes binary not found at %s; install via the memex-hermes "
            "distribution (run `python -m memex_hermes.install` or see the "
            "README). Until then, all binary calls degrade to safe defaults.",
            binary,
        )

    # ---- Internal: fire-and-forget worker thread ------------------------

    def _ensure_worker_running(self) -> None:
        if self._worker_started.is_set():
            return
        with self._worker_lock:
            if self._worker_started.is_set():
                return
            stop = threading.Event()
            worker = threading.Thread(
                target=self._worker_loop,
                args=(stop,),
                name="memex-hermes-runner",
                daemon=True,
            )
            self._worker_stop = stop
            self._worker = worker
            worker.start()
            self._worker_started.set()

    def _enqueue_with_drop_oldest(self, job: _FAFJob) -> None:
        # Try the fast path first.
        try:
            self._queue.put_nowait(job)
            return
        except queue.Full:
            pass
        # Drop the oldest, log, and re-try once.
        try:
            dropped = self._queue.get_nowait()
            self._queue.task_done()
            logger.warning(
                "FAF queue full; dropped oldest pending %s to enqueue %s",
                dropped.event_name,
                job.event_name,
            )
        except queue.Empty:
            # Race: worker consumed it. Fall through to enqueue.
            pass
        try:
            self._queue.put_nowait(job)
        except queue.Full:
            # Extremely unlikely; treat as drop of the incoming.
            logger.warning(
                "FAF queue full after drop-oldest attempt; dropping incoming %s",
                job.event_name,
            )

    def _worker_loop(self, stop: threading.Event) -> None:
        # Block on get(); the stop event alone does not wake a blocked
        # get() call, so we use a small poll interval to check it. Each
        # worker watches the stop event it was created with, so a worker
        # re-armed after ``shutdown`` is never stopped by a prior drain.
        while True:
            try:
                job = self._queue.get(timeout=0.1)
            except queue.Empty:
                if stop.is_set():
                    return
                continue
            try:
                timeout_s = _TIMEOUTS_BY_EVENT.get(job.event_name, _DEFAULT_TIMEOUT_S)
                self._run_blocking(job.event_name, job.envelope, timeout_s)
            finally:
                self._queue.task_done()

    def _mark_inflight_start(self) -> None:
        with self._inflight_lock:
            self._inflight += 1
            self._inflight_drained.clear()

    def _mark_inflight_end(self) -> None:
        with self._inflight_lock:
            self._inflight -= 1
            if self._inflight == 0:
                self._inflight_drained.set()
