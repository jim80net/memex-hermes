// JSON envelope contract between the Python MemoryProvider and the memex-hermes
// binary. Single source of truth — the Python side (memex_hermes/envelope.py)
// mirrors these shapes as TypedDicts. Drift between the two is a contract bug.
//
// The base HookInput from memex-core carries hook_event_name + a few optional
// top-level fields (session_id, cwd, transcript_path, prompt, tool_name,
// tool_input). Hermes events extend it with an `args` payload narrowed by the
// hook_event_name discriminator. Outputs are JSON-serializable and per-event.

import type { HookInput, HookOutput } from "@jim80net/memex-core";

// ---- Event-name constants (the single source of truth) ----------------------

export const HERMES_EVENTS = {
  HEALTH: "Hermes.health",
  INIT: "Hermes.init",
  SYSTEM_PROMPT: "Hermes.system-prompt",
  PREFETCH: "Hermes.prefetch",
  QUEUE_PREFETCH: "Hermes.queue-prefetch",
  SYNC_TURN: "Hermes.sync-turn",
  SESSION_END: "Hermes.session-end",
  PRE_COMPRESS: "Hermes.pre-compress",
  MEMORY_WRITE: "Hermes.memory-write",
  SESSION_SWITCH: "Hermes.session-switch",
  SHUTDOWN: "Hermes.shutdown",
  TOOL_SEARCH: "Hermes.tool-search",
  TOOL_REMEMBER: "Hermes.tool-remember",
  TOOL_RECALL: "Hermes.tool-recall",
} as const;

export type HermesEventName = (typeof HERMES_EVENTS)[keyof typeof HERMES_EVENTS];

// ---- Per-event argument shapes ---------------------------------------------

export type HermesAgentContext = "primary" | "subagent" | "cron" | "flush";

// initialize kwargs the framework auto-injects (hermes_home/platform/agent_context
// always; the rest may be present depending on the platform/gateway path).
export interface HermesInitArgs {
  hermes_home: string;
  platform: string;
  agent_context: HermesAgentContext;
  agent_identity?: string;
  agent_workspace?: string;
  parent_session_id?: string;
  user_id?: string;
  user_name?: string;
  session_title?: string;
  chat_id?: string;
  chat_name?: string;
  chat_type?: string;
  thread_id?: string;
  gateway_session_key?: string;
  // Forward-compatible: any unknown init kwargs are tolerated and forwarded.
  [extra: string]: unknown;
}

export interface HermesPrefetchArgs {
  query: string;
  session_id?: string;
}

export interface HermesQueuePrefetchArgs {
  query: string;
  session_id?: string;
}

export interface HermesSyncTurnArgs {
  user_content: string;
  assistant_content: string;
  session_id?: string;
}

export interface HermesSessionEndArgs {
  messages: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface HermesPreCompressArgs {
  messages: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export type HermesMemoryAction = "add" | "replace" | "remove";
export type HermesMemoryTarget = "memory" | "user";

export interface HermesMemoryWriteArgs {
  action: HermesMemoryAction;
  target: HermesMemoryTarget;
  content: string;
  // Provenance dict from Hermes. Common keys: write_origin, execution_context,
  // session_id, parent_session_id, platform, tool_name. Unknown keys tolerated.
  metadata?: Readonly<Record<string, unknown>>;
}

export interface HermesSessionSwitchArgs {
  new_session_id: string;
  parent_session_id?: string;
  reset?: boolean;
}

export interface HermesToolSearchArgs {
  query: string;
  limit?: number;
  types?: ReadonlyArray<string>;
}

export type HermesToolScope = "session" | "project" | "global";

export interface HermesToolRememberArgs {
  content: string;
  scope?: HermesToolScope;
  projectName?: string;
}

export interface HermesToolRecallArgs {
  name?: string;
  limit?: number;
}

// ---- Input envelope ---------------------------------------------------------

// Extends memex-core's HookInput with an `args` payload narrowed by event name.
export interface HermesHookInput<E extends HermesEventName = HermesEventName, A = unknown>
  extends HookInput {
  hook_event_name: E;
  args?: A;
}

// ---- Per-event output shapes -----------------------------------------------

export interface HermesHealthOutput {
  ready: boolean;
  reason?: string;
}

export interface HermesInitOutput {
  ok: true;
}

export interface HermesSystemPromptOutput {
  block: string;
}

// Prefetch reuses memex-core's HookOutput shape ({ additionalContext?: string }).
export type HermesPrefetchOutput = HookOutput;

// Empty acknowledgement for fire-and-forget events.
export type HermesEmptyOutput = Record<string, never>;

export interface HermesSyncTurnOutput {
  ok: true;
  mirrored?: ReadonlyArray<HermesMemoryTarget>;
}

export interface HermesSessionEndOutput {
  written: number;
}

export interface HermesPreCompressOutput {
  summary?: string;
}

export interface HermesMemoryWriteOutput {
  committed: boolean;
  // When the write was dropped (e.g., non-primary agent_context or _session/*
  // project), this names the reason. Implementations log it; spec scenarios
  // assert it via `informational log line` rather than the response field.
  suppressed?: string;
}

export interface HermesSessionSwitchOutput {
  ok: true;
}

export interface HermesShutdownOutput {
  ok: true;
}

export interface HermesToolSearchResult {
  name: string;
  type: string;
  score: number;
  location: string;
  snippet?: string;
}

export interface HermesToolSearchOutput {
  results: ReadonlyArray<HermesToolSearchResult>;
}

export interface HermesToolRememberOutput {
  written: string;
  synced: boolean;
}

export interface HermesToolRecallEntry {
  name: string;
  content: string;
}

export interface HermesToolRecallOutput {
  entries: ReadonlyArray<HermesToolRecallEntry>;
}

// ---- Per-event input/output pairing (compile-time map) ---------------------

export interface HermesEventMap {
  [HERMES_EVENTS.HEALTH]: { args: Record<string, never>; output: HermesHealthOutput };
  [HERMES_EVENTS.INIT]: { args: HermesInitArgs; output: HermesInitOutput };
  [HERMES_EVENTS.SYSTEM_PROMPT]: { args: Record<string, never>; output: HermesSystemPromptOutput };
  [HERMES_EVENTS.PREFETCH]: { args: HermesPrefetchArgs; output: HermesPrefetchOutput };
  [HERMES_EVENTS.QUEUE_PREFETCH]: { args: HermesQueuePrefetchArgs; output: HermesEmptyOutput };
  [HERMES_EVENTS.SYNC_TURN]: { args: HermesSyncTurnArgs; output: HermesSyncTurnOutput };
  [HERMES_EVENTS.SESSION_END]: { args: HermesSessionEndArgs; output: HermesSessionEndOutput };
  [HERMES_EVENTS.PRE_COMPRESS]: { args: HermesPreCompressArgs; output: HermesPreCompressOutput };
  [HERMES_EVENTS.MEMORY_WRITE]: { args: HermesMemoryWriteArgs; output: HermesMemoryWriteOutput };
  [HERMES_EVENTS.SESSION_SWITCH]: {
    args: HermesSessionSwitchArgs;
    output: HermesSessionSwitchOutput;
  };
  [HERMES_EVENTS.SHUTDOWN]: { args: Record<string, never>; output: HermesShutdownOutput };
  [HERMES_EVENTS.TOOL_SEARCH]: { args: HermesToolSearchArgs; output: HermesToolSearchOutput };
  [HERMES_EVENTS.TOOL_REMEMBER]: { args: HermesToolRememberArgs; output: HermesToolRememberOutput };
  [HERMES_EVENTS.TOOL_RECALL]: { args: HermesToolRecallArgs; output: HermesToolRecallOutput };
}
