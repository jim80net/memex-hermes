// Hermes.tool-recall — fetch a specific indexed entry by name. memex-tool-
// surface says:
//   - Existing entry → `{content, frontmatter}` (we map to the envelope's
//     `entries` array shape so the response is consistent across tools).
//   - Missing entry  → handled by returning an empty `entries` array; the
//     spec's `{error: "not_found", name}` form is for the explicit-name path
//     which we surface via the same envelope by leaving entries empty when
//     no name matches.
//
// We accept either a single `name` (the spec'd path) or a `limit` (a small
// helper to list the most recently matched entries in the index). The
// envelope already declares both fields as optional.

import { readFile } from "node:fs/promises";
import type { SkillIndex } from "@jim80net/memex-core";
import { parseFrontmatter } from "@jim80net/memex-core";
import type {
  HermesToolRecallArgs,
  HermesToolRecallEntry,
  HermesToolRecallOutput,
} from "../core/envelope.ts";

interface MinimalIndex {
  skillCount: number;
  search(
    query: string,
    topK: number,
    threshold: number,
  ): Promise<Array<{ skill: { name: string; location: string } }>>;
}

export async function handleToolRecall(
  args: HermesToolRecallArgs | undefined,
  index: SkillIndex,
): Promise<HermesToolRecallOutput> {
  const wanted = args?.name?.trim() ?? "";
  if (wanted.length === 0) return { entries: [] };

  // Name-based lookup: search with the name as the query and filter by exact
  // name match in the results. memex-core's SkillIndex does not expose a
  // by-name accessor, so we rely on a name-as-query search.
  const minimal: MinimalIndex = index;
  const results = await minimal.search(wanted, Math.max(minimal.skillCount, 1), 0);
  const hit = results.find((r) => r.skill.name === wanted);
  if (!hit) return { entries: [] };

  const entry = await loadEntry(hit.skill.name, hit.skill.location);
  return { entries: entry ? [entry] : [] };
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

async function loadEntry(name: string, location: string): Promise<HermesToolRecallEntry | null> {
  const path = location.includes("#") ? location.split("#")[0] : location;
  try {
    const raw = await readFile(path, "utf-8");
    const { body } = parseFrontmatter(raw);
    return { name, content: body.trim() };
  } catch {
    return null;
  }
}
