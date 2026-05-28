// Hermes.memory-write — primary mirror path for built-in `add` / `replace`.
//
// Per hermes-sync-bridge R1 the built-in memory tool gates its callback on
// action in {"add","replace"} (tool_executor.py:640); we receive the same
// action verb here and pick our behavior accordingly. A built-in `remove`
// will never reach this handler — sync-turn's mtime-watcher picks that up.
//
// Suppression (R5 / R7):
//   - state.agentContext in {subagent, cron, flush} → drop.
//   - metadata.execution_context in those same values → drop.
//   - project ID `_session/*` → mirror locally but skip push (mirrorAndCommit
//     handles that internally).
//
// Per the envelope contract, suppressed writes return committed:false with a
// `suppressed` reason string for diagnostics.

import type { Logger } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type {
  HermesAgentContext,
  HermesMemoryWriteArgs,
  HermesMemoryWriteOutput,
} from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import { getState } from "../state.ts";
import { mirrorAndCommit } from "./_mirror.ts";

const NON_PRIMARY_CONTEXTS: ReadonlySet<HermesAgentContext> = new Set([
  "subagent",
  "cron",
  "flush",
]);

export async function handleMemoryWrite(
  args: HermesMemoryWriteArgs | undefined,
  cwd: string,
  config: HermesConfig,
  paths: HermesPaths,
  logger?: Logger,
): Promise<HermesMemoryWriteOutput> {
  if (!args) {
    return { committed: false, suppressed: "missing args" };
  }

  if (!config.mirrorHermesMemory) {
    logger?.info("memex-hermes[memory-write]: mirrorHermesMemory disabled; skipping");
    return { committed: false, suppressed: "mirrorHermesMemory disabled" };
  }

  // R5: suppression by captured agent_context.
  const state = getState();
  if (NON_PRIMARY_CONTEXTS.has(state.agentContext)) {
    const reason = `non-primary agent_context: ${state.agentContext}`;
    logger?.info(`memex-hermes[memory-write]: ${reason}`);
    return { committed: false, suppressed: reason };
  }

  // R5: suppression by per-write metadata.execution_context.
  const metaContext = readExecutionContext(args.metadata);
  if (metaContext && NON_PRIMARY_CONTEXTS.has(metaContext)) {
    const reason = `metadata.execution_context=${metaContext}`;
    logger?.info(`memex-hermes[memory-write]: ${reason}`);
    return { committed: false, suppressed: reason };
  }

  // The built-in `remove` action does not fire on_memory_write per
  // tool_executor.py:640; if we see it anyway treat it as a no-op here and
  // rely on the mtime-watcher to mirror the actual content.
  if (args.action === "remove") {
    return { committed: false, suppressed: "remove handled by mtime watcher" };
  }

  const result = await mirrorAndCommit(
    {
      target: args.target,
      content: args.content,
      cwd,
      sessionId: state.sessionId,
      reason: `memory-write ${args.action}`,
    },
    config,
    paths.syncRepoDir,
    logger,
  );

  // Push suppression for _session/* is recorded by mirrorAndCommit itself;
  // here we report committed-ness as the public contract.
  return result.committed ? { committed: true } : { committed: false };
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function readExecutionContext(
  metadata: Readonly<Record<string, unknown>> | undefined,
): HermesAgentContext | null {
  if (!metadata) return null;
  const raw = metadata.execution_context;
  if (typeof raw !== "string") return null;
  if (raw === "primary" || raw === "subagent" || raw === "cron" || raw === "flush") {
    return raw;
  }
  return null;
}
