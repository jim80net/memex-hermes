// Hermes.system-prompt — static session-lifetime block.
//
// D5 mandates byte-identical output on repeated calls within a session. The
// block describes the inventory of memex_* tools that the agent can call and
// summarizes whether sync is on. Computed once per process and cached in
// state.ts; cleared only by Hermes.session-switch with reset=true.

import type { HermesConfig } from "../core/config.ts";
import type { HermesSystemPromptOutput } from "../core/envelope.ts";
import { getState, setSystemPromptBlock } from "../state.ts";

export function handleSystemPrompt(config: HermesConfig): HermesSystemPromptOutput {
  const cached = getState().systemPromptBlock;
  if (cached !== null) {
    return { block: cached };
  }

  const block = buildBlock(config);
  setSystemPromptBlock(block);
  return { block };
}

function buildBlock(config: HermesConfig): string {
  const lines: string[] = [];
  lines.push("## memex-hermes");
  lines.push("");
  lines.push("Semantic memory and skill search backed by an on-disk index. Three tools available:");
  lines.push("");
  if (config.tools.memex_search.enabled) {
    lines.push(
      "- `memex_search(query, limit?, types?)` — explicit semantic search over skills, memories, rules.",
    );
  }
  if (config.tools.memex_remember.enabled) {
    lines.push(
      "- `memex_remember(content, scope?, projectName?)` — persist a memory entry; sync repo when configured.",
    );
  }
  if (config.tools.memex_recall.enabled) {
    lines.push("- `memex_recall(name)` — fetch a specific memory or skill entry by name.");
  }
  lines.push("");
  if (config.sync.enabled && config.sync.repo.length > 0) {
    lines.push(`Sync: enabled (repo \`${config.sync.repo}\`).`);
  } else {
    lines.push("Sync: disabled. Entries stay local to this host.");
  }
  return lines.join("\n");
}
