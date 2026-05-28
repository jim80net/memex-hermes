"""JSON envelope contract between the Python MemoryProvider and the memex-hermes binary.

Mirrors `src/core/envelope.ts` exactly. Drift between the two sides is a
contract bug — when one moves, the other moves with it (the integration test
under `test/e2e/` round-trips an envelope through both sides to catch drift).

The base shape extends memex-core's `HookInput` (`hook_event_name` plus optional
`session_id`, `cwd`, `transcript_path`). Hermes events carry an `args` payload
narrowed at the receiver by the `hook_event_name` discriminator. Per-event
outputs are JSON-serializable shapes the binary writes back on stdout.

Strict typing notes:
- `args` and `metadata` are `Mapping[str, Any]` at the envelope boundary because
  Hermes can pass arbitrary kwargs/metadata; the receiver narrows them via the
  per-event `TypedDict`s declared below.
- Per CLAUDE.md, `Any` is permitted at the Hermes ABC boundary and is narrowed
  before entering internal code.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Final, Literal, TypedDict

from typing_extensions import NotRequired

# ---- Event-name constants (single source of truth) -------------------------

HERMES_HEALTH: Final = "Hermes.health"
HERMES_INIT: Final = "Hermes.init"
HERMES_SYSTEM_PROMPT: Final = "Hermes.system-prompt"
HERMES_PREFETCH: Final = "Hermes.prefetch"
HERMES_QUEUE_PREFETCH: Final = "Hermes.queue-prefetch"
HERMES_SYNC_TURN: Final = "Hermes.sync-turn"
HERMES_SESSION_END: Final = "Hermes.session-end"
HERMES_PRE_COMPRESS: Final = "Hermes.pre-compress"
HERMES_MEMORY_WRITE: Final = "Hermes.memory-write"
HERMES_SESSION_SWITCH: Final = "Hermes.session-switch"
HERMES_SHUTDOWN: Final = "Hermes.shutdown"
HERMES_TOOL_SEARCH: Final = "Hermes.tool-search"
HERMES_TOOL_REMEMBER: Final = "Hermes.tool-remember"
HERMES_TOOL_RECALL: Final = "Hermes.tool-recall"

HermesEventName = Literal[
    "Hermes.health",
    "Hermes.init",
    "Hermes.system-prompt",
    "Hermes.prefetch",
    "Hermes.queue-prefetch",
    "Hermes.sync-turn",
    "Hermes.session-end",
    "Hermes.pre-compress",
    "Hermes.memory-write",
    "Hermes.session-switch",
    "Hermes.shutdown",
    "Hermes.tool-search",
    "Hermes.tool-remember",
    "Hermes.tool-recall",
]

HermesAgentContext = Literal["primary", "subagent", "cron", "flush"]
HermesMemoryAction = Literal["add", "replace", "remove"]
HermesMemoryTarget = Literal["memory", "user"]
HermesToolScope = Literal["session", "project", "global"]

# ---- Per-event argument shapes --------------------------------------------


class HermesInitArgs(TypedDict, total=False):
    """`Hermes.init` args — initialize kwargs forwarded from the framework.

    `hermes_home`, `platform`, `agent_context` are always present (auto-injected
    by the framework + agent_init.py); the remaining keys are platform / gateway
    specific. Forward-compat: unknown keys are tolerated.
    """

    hermes_home: str
    platform: str
    agent_context: HermesAgentContext
    agent_identity: str
    agent_workspace: str
    parent_session_id: str
    user_id: str
    user_name: str
    session_title: str
    chat_id: str
    chat_name: str
    chat_type: str
    thread_id: str
    gateway_session_key: str


class HermesPrefetchArgs(TypedDict):
    query: str
    session_id: NotRequired[str]


class HermesQueuePrefetchArgs(TypedDict):
    query: str
    session_id: NotRequired[str]


class HermesSyncTurnArgs(TypedDict):
    user_content: str
    assistant_content: str
    session_id: NotRequired[str]


class HermesSessionEndArgs(TypedDict):
    messages: Sequence[Mapping[str, Any]]


class HermesPreCompressArgs(TypedDict):
    messages: Sequence[Mapping[str, Any]]


class HermesMemoryWriteArgs(TypedDict):
    action: HermesMemoryAction
    target: HermesMemoryTarget
    content: str
    metadata: NotRequired[Mapping[str, Any]]


class HermesSessionSwitchArgs(TypedDict):
    new_session_id: str
    parent_session_id: NotRequired[str]
    reset: NotRequired[bool]


class HermesToolSearchArgs(TypedDict):
    query: str
    limit: NotRequired[int]
    types: NotRequired[Sequence[str]]


class HermesToolRememberArgs(TypedDict):
    content: str
    scope: NotRequired[HermesToolScope]
    projectName: NotRequired[str]


class HermesToolRecallArgs(TypedDict):
    name: NotRequired[str]
    limit: NotRequired[int]


# ---- Input envelope -------------------------------------------------------


class HermesHookInput(TypedDict, total=False):
    """The JSON envelope written to the binary's stdin.

    `hook_event_name` is required; `args` is per-event (narrowed by receiver).
    """

    hook_event_name: HermesEventName
    session_id: str
    cwd: str
    transcript_path: str
    args: Mapping[str, Any]


# ---- Per-event output shapes ---------------------------------------------


class HermesHealthOutput(TypedDict):
    ready: bool
    reason: NotRequired[str]


class HermesInitOutput(TypedDict):
    ok: Literal[True]


class HermesSystemPromptOutput(TypedDict):
    block: str


class HermesPrefetchOutput(TypedDict, total=False):
    additionalContext: str


class HermesEmptyOutput(TypedDict):
    """`{}` — used by fire-and-forget events that have no payload to return."""


class HermesSyncTurnOutput(TypedDict, total=False):
    ok: Literal[True]
    mirrored: Sequence[HermesMemoryTarget]


class HermesSessionEndOutput(TypedDict):
    written: int


class HermesPreCompressOutput(TypedDict, total=False):
    summary: str


class HermesMemoryWriteOutput(TypedDict, total=False):
    committed: bool
    suppressed: str


class HermesSessionSwitchOutput(TypedDict):
    ok: Literal[True]


class HermesShutdownOutput(TypedDict):
    ok: Literal[True]


class HermesToolSearchResult(TypedDict, total=False):
    name: str
    type: str
    score: float
    location: str
    snippet: str


class HermesToolSearchOutput(TypedDict):
    results: Sequence[HermesToolSearchResult]


class HermesToolRememberOutput(TypedDict):
    written: str
    synced: bool


class HermesToolRecallEntry(TypedDict):
    name: str
    content: str


class HermesToolRecallOutput(TypedDict):
    entries: Sequence[HermesToolRecallEntry]
