#!/usr/bin/env node

// memex-hermes binary entry point.
//
// The Python MemexProvider shim writes a JSON `HermesHookInput` envelope to
// our stdin, we dispatch on `hook_event_name`, and write the result as JSON
// to stdout. The binary is single-shot per invocation — no daemon mode.
//
// Initialization (LocalEmbeddingProvider, SkillIndex.build) is performed
// once at the top because nearly every event needs the index. The cost is
// paid up-front, the warm-cache fast path keeps it cheap on rebuild.

import { join } from "node:path";
import type {
  EmbeddingProvider,
  Logger,
  ScanRootRegistry,
  SkillIndex as SkillIndexCtor,
} from "@jim80net/memex-core";
import { LocalEmbeddingProvider, SkillIndex } from "@jim80net/memex-core";
import type { HermesConfig } from "./core/config.ts";
import { loadConfig } from "./core/config.ts";
import {
  HERMES_EVENTS,
  type HermesAgentContext,
  type HermesEventName,
  type HermesHookInput,
  type HermesMemoryWriteArgs,
  type HermesPrefetchArgs,
  type HermesQueuePrefetchArgs,
  type HermesSessionEndArgs,
  type HermesSessionSwitchArgs,
  type HermesSyncTurnArgs,
  type HermesToolRecallArgs,
  type HermesToolRememberArgs,
  type HermesToolSearchArgs,
} from "./core/envelope.ts";
import { applySyncRepoOverride, getHermesPaths, type HermesPaths } from "./core/hermes-paths.ts";
import { assembleHermesScanDirs, buildHermesScanRoots } from "./core/scan-roots.ts";
import { handleHealth } from "./hooks/health.ts";
import { handleInit } from "./hooks/init.ts";
import { handleMemoryWrite } from "./hooks/memory-write.ts";
import { handlePreCompress } from "./hooks/pre-compress.ts";
import { handlePrefetch } from "./hooks/prefetch.ts";
import { handleQueuePrefetch } from "./hooks/queue-prefetch.ts";
import { handleSessionEnd } from "./hooks/session-end.ts";
import { handleSessionSwitch } from "./hooks/session-switch.ts";
import { handleShutdown } from "./hooks/shutdown.ts";
import { handleSyncTurn } from "./hooks/sync-turn.ts";
import { handleSystemPrompt } from "./hooks/system-prompt.ts";
import { handleToolRecall } from "./hooks/tool-recall.ts";
import { handleToolRemember } from "./hooks/tool-remember.ts";
import { handleToolSearch } from "./hooks/tool-search.ts";
import { seedFromEnvelope } from "./state.ts";

// ---------------------------------------------------------------------------
// Public — entry
// ---------------------------------------------------------------------------

export async function dispatch(
  input: HermesHookInput,
  options: DispatchOptions = {},
): Promise<unknown> {
  const config = options.config ?? (await loadConfig());
  if (!config.enabled) return {};

  // Wire the config-level sync.repo override into the runtime paths.
  // applySyncRepoOverride short-circuits to the base value for empty / git-URL
  // overrides; only a local-filesystem path actually moves the checkout.
  const paths: HermesPaths = applySyncRepoOverride(options.paths ?? getHermesPaths(), config.sync);
  const cwd = input.cwd ?? "";
  const sessionId = input.session_id ?? "";
  const logger = options.logger ?? defaultLogger();

  // Seed per-invocation context BEFORE dispatch. The binary is single-shot, so
  // captureInit only ran in the separate Hermes.init subprocess; without this,
  // every other event reads a stale empty STATE (sessionId="", context default
  // "primary"). The session id is a top-level envelope field; agent_context
  // rides in the args of write events when the Python provider forwards it.
  seedFromEnvelope({ sessionId, agentContext: readAgentContext(input.args) });

  const { provider, index, registry } = await getIndex(config, paths, cwd, options);

  switch (input.hook_event_name) {
    case HERMES_EVENTS.HEALTH:
      return await handleHealth(config, paths.syncRepoDir, logger);
    case HERMES_EVENTS.INIT:
      return await handleInit(
        input.args as Parameters<typeof handleInit>[0],
        cwd,
        sessionId,
        config,
        paths,
        logger,
      );
    case HERMES_EVENTS.SYSTEM_PROMPT:
      return handleSystemPrompt(config);
    case HERMES_EVENTS.PREFETCH:
      return await handlePrefetch(
        input.args as HermesPrefetchArgs | undefined,
        index,
        config,
        paths,
        sessionId,
        registry,
        logger,
      );
    case HERMES_EVENTS.QUEUE_PREFETCH:
      return await handleQueuePrefetch(
        input.args as HermesQueuePrefetchArgs | undefined,
        provider,
        config,
        logger,
      );
    case HERMES_EVENTS.SYNC_TURN:
      return await handleSyncTurn(
        input.args as HermesSyncTurnArgs | undefined,
        cwd,
        config,
        paths,
        logger,
      );
    case HERMES_EVENTS.SESSION_END:
      return await handleSessionEnd(
        input.args as HermesSessionEndArgs | undefined,
        cwd,
        config,
        paths,
        logger,
      );
    case HERMES_EVENTS.PRE_COMPRESS:
      return await handlePreCompress(cwd, config, paths, logger);
    case HERMES_EVENTS.MEMORY_WRITE:
      return await handleMemoryWrite(
        input.args as HermesMemoryWriteArgs | undefined,
        cwd,
        config,
        paths,
        logger,
      );
    case HERMES_EVENTS.SESSION_SWITCH:
      return handleSessionSwitch(input.args as HermesSessionSwitchArgs | undefined);
    case HERMES_EVENTS.SHUTDOWN:
      return handleShutdown(logger);
    case HERMES_EVENTS.TOOL_SEARCH:
      return await handleToolSearch(input.args as HermesToolSearchArgs | undefined, index, config);
    case HERMES_EVENTS.TOOL_REMEMBER:
      return await handleToolRemember(
        input.args as HermesToolRememberArgs | undefined,
        cwd,
        config,
        paths,
        logger,
      );
    case HERMES_EVENTS.TOOL_RECALL:
      return await handleToolRecall(input.args as HermesToolRecallArgs | undefined, index);
    default: {
      // The HermesEventName union covers every constant, so this default arm
      // only runs when the runtime sees a string outside the union — e.g. a
      // malformed envelope. Returning a structured error is part of the spec
      // ("Unknown Hermes.* event returns a structured error").
      const unknown: string = (input as { hook_event_name: string }).hook_event_name;
      return { error: "unknown_event", hook_event_name: unknown };
    }
  }
}

export interface DispatchOptions {
  config?: HermesConfig;
  paths?: HermesPaths;
  provider?: EmbeddingProvider;
  index?: SkillIndexCtor;
  logger?: Logger;
}

// Exposed for tests/typecheck: ensures the dispatch switch covers every
// declared HermesEventName. Treating any event as `never` after the switch
// would let the compiler reject a missing case statically — this helper
// turns that compile-time discipline into a runtime no-op.
export function _exhaustivenessGuard(event: HermesEventName): HermesEventName {
  return event;
}

// ---------------------------------------------------------------------------
// Public — CLI wrapper
// ---------------------------------------------------------------------------

export type StructuredErrorOutput = { error: string; reason?: string };

export async function runFromStdin(): Promise<void> {
  const raw = await readStdin();
  let input: HermesHookInput;
  try {
    input = JSON.parse(raw) as HermesHookInput;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`memex-hermes: invalid JSON on stdin: ${reason}\n`);
    process.stdout.write(JSON.stringify({ error: "invalid_json", reason }));
    process.exit(1);
  }

  if (!input || typeof input.hook_event_name !== "string") {
    process.stdout.write(JSON.stringify({ error: "missing_hook_event_name" }));
    process.exit(1);
  }

  try {
    const result = await dispatch(input);
    process.stdout.write(JSON.stringify(result ?? {}));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`memex-hermes: handler error: ${reason}\n`);
    process.stdout.write(JSON.stringify({ error: "handler_failure", reason }));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function getIndex(
  config: HermesConfig,
  paths: HermesPaths,
  cwd: string,
  options: DispatchOptions,
): Promise<{ provider: EmbeddingProvider; index: SkillIndexCtor; registry: ScanRootRegistry }> {
  if (options.index && options.provider) {
    return {
      provider: options.provider,
      index: options.index,
      registry: [],
    };
  }
  const provider =
    options.provider ?? new LocalEmbeddingProvider(config.embeddingModel, paths.modelsDir);
  const cachePath = join(paths.cacheDir, "memex-cache.json");

  const scanDirs = await assembleHermesScanDirs(config, paths, cwd);
  const registry = buildHermesScanRoots(cwd, paths, scanDirs, config.sync.enabled);
  const index = options.index ?? new SkillIndex(config, provider, cachePath, { registry });

  try {
    await index.build(scanDirs);
  } catch (err) {
    process.stderr.write(
      `memex-hermes: index build failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }
  return { provider, index, registry };
}

// Narrow the optional agent_context carried in a write event's args. The Python
// provider forwards it on memory-write / sync-turn / queue-prefetch envelopes so
// the binary's suppression gate has a live signal even though captureInit only
// ran in the separate init subprocess. Any other event (or a missing field)
// returns undefined, leaving STATE.agentContext at its default.
function readAgentContext(args: unknown): HermesAgentContext | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const raw = (args as { agent_context?: unknown }).agent_context;
  if (raw === "primary" || raw === "subagent" || raw === "cron" || raw === "flush") {
    return raw;
  }
  return undefined;
}

function defaultLogger(): Logger {
  return {
    info: (m) => process.stderr.write(`memex-hermes[info]: ${m}\n`),
    warn: (m) => process.stderr.write(`memex-hermes[warn]: ${m}\n`),
    error: (m) => process.stderr.write(`memex-hermes[error]: ${m}\n`),
  };
}

// Entry point when invoked directly (not imported by tests).
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("main.ts") ||
    process.argv[1].endsWith("main.js") ||
    process.argv[1].endsWith("/memex-hermes"));

if (invokedDirectly) {
  runFromStdin().catch((err) => {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`memex-hermes: fatal: ${reason}\n`);
    process.exit(1);
  });
}
