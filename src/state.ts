// Process-lifetime state. The memex-hermes binary is single-shot per
// invocation, but a handler still needs to consult things captured at
// `Hermes.init` (agent_context, hermes_home) or things cached across calls
// during testing harnesses that exercise multiple events in one process
// (vitest, the in-process dispatcher).
//
// Persistence across subprocess boundaries belongs to disk-backed modules
// (memory-mtimes.json, sessions/<id>.json, telemetry, registry). This module
// is the in-memory scratchpad for everything that can legitimately reset on
// process restart.

import type { HermesAgentContext, HermesMemoryTarget } from "./core/envelope.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrefetchInjection {
  location: string;
  bestQueryIndex: number;
}

export interface HermesState {
  agentContext: HermesAgentContext;
  sessionId: string;
  hermesHome: string;
  // Mtime tracker keyed by absolute path (MEMORY.md / USER.md). Loaded
  // lazily from disk by sync-turn; null means "not yet read on this run".
  memoryMtimes: Map<string, number> | null;
  // Buffer of entries injected by the most recent Hermes.prefetch. Read by
  // Hermes.sync-turn to attribute telemetry now that the model has seen them.
  // Resets on every prefetch and on session-switch with reset=true.
  lastPrefetchInjections: PrefetchInjection[];
  // Cached static system prompt block per D5: byte-identical across calls in
  // the same session lifetime. Cleared on session-switch.
  systemPromptBlock: string | null;
  // In-process embedding cache populated by queue-prefetch. Keyed by query
  // string with an expiry timestamp so subsequent prefetch can short-circuit.
  queryEmbeddingCache: Map<string, { embedding: number[]; expiresAt: number }>;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

const STATE: HermesState = createEmpty();

export function getState(): HermesState {
  return STATE;
}

export function resetState(): void {
  Object.assign(STATE, createEmpty());
}

export function captureInit(args: {
  agentContext: HermesAgentContext;
  sessionId: string;
  hermesHome: string;
}): void {
  STATE.agentContext = args.agentContext;
  STATE.sessionId = args.sessionId;
  STATE.hermesHome = args.hermesHome;
}

/**
 * Seed per-invocation context from the dispatch envelope. The binary is
 * single-shot, so `captureInit` only ran in the separate `Hermes.init`
 * subprocess; every OTHER event (memory-write, sync-turn, session-end,
 * tool-remember) lands in a fresh process where STATE is empty. Without this
 * seed those handlers would read sessionId="" / agentContext="primary" on
 * every call, defeating the per-write suppression gate and dropping the
 * session id from mirror commits.
 *
 * The envelope carries the session id at the top level on every event; the
 * agent_context rides in the event args when the Python provider forwards it
 * (write events only). A missing agent_context leaves the default "primary"
 * untouched so read events behave as before.
 */
export function seedFromEnvelope(args: {
  sessionId?: string;
  agentContext?: HermesAgentContext;
}): void {
  if (args.sessionId !== undefined && args.sessionId.length > 0) {
    STATE.sessionId = args.sessionId;
  }
  if (args.agentContext !== undefined) {
    STATE.agentContext = args.agentContext;
  }
}

export function setSessionId(sessionId: string, reset: boolean): void {
  STATE.sessionId = sessionId;
  if (reset) {
    STATE.lastPrefetchInjections = [];
    STATE.systemPromptBlock = null;
    STATE.queryEmbeddingCache.clear();
  }
}

export function setSystemPromptBlock(block: string): void {
  STATE.systemPromptBlock = block;
}

export function recordPrefetchInjections(injections: PrefetchInjection[]): void {
  STATE.lastPrefetchInjections = injections;
}

export function takePrefetchInjections(): PrefetchInjection[] {
  const out = STATE.lastPrefetchInjections;
  STATE.lastPrefetchInjections = [];
  return out;
}

export function setMemoryMtimes(map: Map<string, number>): void {
  STATE.memoryMtimes = map;
}

export function cacheQueryEmbedding(query: string, embedding: number[], ttlMs: number): void {
  STATE.queryEmbeddingCache.set(query, {
    embedding,
    expiresAt: Date.now() + ttlMs,
  });
}

export function getCachedQueryEmbedding(query: string): number[] | null {
  const hit = STATE.queryEmbeddingCache.get(query);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    STATE.queryEmbeddingCache.delete(query);
    return null;
  }
  return hit.embedding;
}

export type { HermesMemoryTarget };

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function createEmpty(): HermesState {
  return {
    agentContext: "primary",
    sessionId: "",
    hermesHome: "",
    memoryMtimes: null,
    lastPrefetchInjections: [],
    systemPromptBlock: null,
    queryEmbeddingCache: new Map(),
  };
}
