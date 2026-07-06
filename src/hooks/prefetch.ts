// Hermes.prefetch — semantic search + injection formatting.
//
// Ports the disclosure rules from memex-claude/src/hooks/user-prompt.ts:
//   - rule: full content on first match this session, one-liner reminder on
//           subsequent matches (G19 / D5).
//   - memory / session-learning: always full body (they're short).
//   - skill / workflow / tool-guidance: name + description teaser pointing at
//           the file location.
//
// Telemetry attribution (recordMatch) runs for entries that actually made it
// into the injection budget; the location + bestQueryIndex tuple is stored on
// process state for the next Hermes.sync-turn (which is when the turn has
// completed and the model has had a chance to USE the injection).

import { mkdir } from "node:fs/promises";
import type { Logger, ScanRootRegistry, SkillIndex } from "@jim80net/memex-core";
import { resolvePortableLocationResolved } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type { HermesPrefetchArgs, HermesPrefetchOutput } from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import { savePrefetchInjections } from "../core/prefetch-injections.ts";
import { hasRuleBeenShown, loadSession, markRuleShown, saveSession } from "../core/session.ts";
import { recordPrefetchInjections } from "../state.ts";

export async function handlePrefetch(
  args: HermesPrefetchArgs | undefined,
  index: SkillIndex,
  config: HermesConfig,
  paths: HermesPaths,
  sessionId: string,
  registry: ScanRootRegistry = [],
  logger?: Logger,
): Promise<HermesPrefetchOutput> {
  const query = args?.query?.trim();
  if (!query) return {};

  const results = await index.search(
    query,
    config.prefetch.topK,
    config.prefetch.threshold,
    config.prefetch.types,
  );
  if (results.length === 0) return {};

  const sid = args?.session_id ?? sessionId;
  const session = await loadSession(sid, paths.sessionsDir);

  let totalChars = 0;
  const sections: string[] = [];
  const injected: Array<{ location: string; bestQueryIndex: number }> = [];
  let sessionDirty = false;

  for (const result of results) {
    const { skill, score } = result;
    const relevance = `${(score * 100).toFixed(0)}%`;
    let section: string | null = null;

    if (skill.type === "rule") {
      if (hasRuleBeenShown(session, skill.location)) {
        const reminder = skill.oneLiner ?? skill.description;
        section = `## Rule reminder: ${skill.name} (relevance: ${relevance})\n\n${reminder}`;
      } else {
        const body = await safeReadBody(index, skill.location);
        if (body !== null) {
          section = `## Rule: ${skill.name} (relevance: ${relevance})\n\n${body}`;
          markRuleShown(session, skill.location);
          sessionDirty = true;
        }
      }
    } else if (skill.type === "memory" || skill.type === "session-learning") {
      const body = await safeReadBody(index, skill.location);
      if (body !== null) {
        section = `## Recalled Memory: ${skill.name} (relevance: ${relevance})\n\n${body}`;
      }
    } else {
      const { filePath: displayPath } = resolvePortableLocationResolved(
        registry,
        skill.location,
        { allowAbsolute: true },
      );
      section =
        `## Available Skill: ${skill.name} (relevance: ${relevance})\n\n` +
        `**${skill.name}**: ${skill.description}\n\n` +
        `To use this skill, read the full instructions at: \`${displayPath}\``;
    }

    if (section === null) continue;
    if (totalChars + section.length > config.prefetch.maxInjectedChars) break;

    sections.push(section);
    injected.push({ location: skill.location, bestQueryIndex: result.bestQueryIndex });
    totalChars += section.length;
  }

  if (sessionDirty && sid.length > 0) {
    try {
      // saveSession wraps the write in a non-recursive lock mkdir; ensure the
      // parent dir exists first so first-write doesn't spin for 5 s.
      await mkdir(paths.sessionsDir, { recursive: true });
      await saveSession(session, paths.sessionsDir);
    } catch (err) {
      logger?.warn(`memex-hermes[prefetch]: session save failed: ${errMsg(err)}`);
    }
  }

  // Sync-turn picks these up to attribute telemetry once the model has
  // observed the injection. The in-process record serves single-process test
  // harnesses; the disk handoff is what actually survives to the next
  // (separate) sync-turn subprocess in production.
  recordPrefetchInjections(injected);
  try {
    await savePrefetchInjections(sid, paths.cacheDir, injected);
  } catch (err) {
    logger?.warn(`memex-hermes[prefetch]: injection persist failed: ${errMsg(err)}`);
  }

  if (sections.length === 0) return {};

  const additionalContext = [
    "The following was automatically loaded based on semantic relevance to your message:",
    "",
    ...sections,
    "",
    "---",
  ].join("\n");

  return { additionalContext };
}

async function safeReadBody(index: SkillIndex, location: string): Promise<string | null> {
  try {
    return await index.readSkillContent(location);
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
