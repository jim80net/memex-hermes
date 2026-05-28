import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionState } from "@jim80net/memex-core";
import { withFileLock } from "@jim80net/memex-core";

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Absolute path to the on-disk state file for a session. memex-core ships only
 * an in-memory tracker; Hermes needs file-based persistence because each turn
 * is a fresh subprocess, so shown-rule state must survive process exit.
 */
export function getSessionPath(sessionId: string, sessionsDir: string): string {
  return join(sessionsDir, `${sessionId}.json`);
}

/**
 * Load a session's persisted state. A missing, empty, or unparseable file
 * yields a fresh empty state — a corrupt session file must never crash a turn.
 */
export async function loadSession(
  sessionId: string | undefined,
  sessionsDir: string,
): Promise<SessionState> {
  const empty: SessionState = { sessionId: sessionId ?? "", shownRules: {} };
  if (!sessionId) return empty;

  try {
    const raw = await readFile(getSessionPath(sessionId, sessionsDir), "utf-8");
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    return {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : sessionId,
      shownRules: isShownRules(parsed.shownRules) ? parsed.shownRules : {},
    };
  } catch {
    return empty;
  }
}

/**
 * Persist session state with an atomic temp-file + rename, serialized behind a
 * file lock so concurrent subprocesses on the same host never interleave
 * partial writes (design §10.1 / F8). A state with no sessionId is a no-op.
 */
export async function saveSession(state: SessionState, sessionsDir: string): Promise<void> {
  if (!state.sessionId) return;

  const path = getSessionPath(state.sessionId, sessionsDir);
  await withFileLock(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state), "utf-8");
    await rename(tmpPath, path);
  });
}

export function hasRuleBeenShown(state: SessionState, location: string): boolean {
  return location in state.shownRules;
}

export function markRuleShown(state: SessionState, location: string): void {
  state.shownRules[location] = Date.now();
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function isShownRules(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((v) => typeof v === "number");
}
