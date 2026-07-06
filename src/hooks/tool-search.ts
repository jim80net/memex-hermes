// Hermes.tool-search — explicit semantic search exposed as an agent-callable
// tool. memex-tool-surface spec: `{query, limit?, types?} → {results:[
// {name,type,score,location,snippet}]}`. Threshold is taken from the dedicated
// `tools.memex_search.threshold` config field, not the prefetch threshold.

import type { SkillIndex } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type {
  HermesToolSearchArgs,
  HermesToolSearchOutput,
  HermesToolSearchResult,
} from "../core/envelope.ts";

const SNIPPET_CHARS = 240;

export async function handleToolSearch(
  args: HermesToolSearchArgs | undefined,
  index: SkillIndex,
  config: HermesConfig,
): Promise<HermesToolSearchOutput> {
  if (!args?.query || args.query.trim().length === 0) {
    return { results: [] };
  }

  const limit = args.limit ?? config.tools.memex_search.defaultLimit;
  const threshold = config.tools.memex_search.threshold;
  const types = args.types && args.types.length > 0 ? [...args.types] : undefined;

  // SkillType is the legal value space; the cast lets us forward an
  // unverified array from the caller, with the search engine itself
  // ignoring any value that doesn't match an indexed entry's type.
  const results = await index.search(
    args.query,
    limit,
    threshold,
    types as HermesToolSearchInputTypes,
  );

  const shaped: HermesToolSearchResult[] = [];
  for (const r of results) {
    shaped.push({
      name: r.skill.name,
      type: r.skill.type,
      score: r.score,
      location: r.skill.location,
      snippet: await readSnippet(index, r.skill.location),
    });
  }
  return { results: shaped };
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

// The SkillIndex.search type filter takes a SkillType[]; the tool input is
// stringly typed. We forward the strings as-is — non-matching types simply
// produce zero results. This narrow alias documents the boundary instead of
// a bare `any`.
type HermesToolSearchInputTypes = Parameters<SkillIndex["search"]>[3];

async function readSnippet(index: SkillIndex, location: string): Promise<string | undefined> {
  try {
    const body = await index.readSkillContent(location);
    return body.slice(0, SNIPPET_CHARS);
  } catch {
    return undefined;
  }
}
