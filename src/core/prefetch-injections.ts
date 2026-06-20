// Disk-backed handoff of prefetch injections from Hermes.prefetch to the
// subsequent Hermes.sync-turn (P2-2).
//
// The binary is single-shot: prefetch runs in one subprocess and records the
// entries it injected; sync-turn runs in a LATER, SEPARATE subprocess and is
// the point at which the model has actually observed the injection, so that is
// when telemetry attribution (recordMatch) must fire. In-process state (state.ts
// lastPrefetchInjections) never survives that boundary, so the pending set is
// persisted to a per-session JSON file under the cache dir and loaded+deleted
// (take-once) by sync-turn. A missing file means "no pending injections" — a
// benign no-op.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "@jim80net/memex-core";
import type { PrefetchInjection } from "../state.ts";

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Absolute path to the pending-injections file for a session. Co-located with
 * the other per-session cache files so it shares the cache dir's lifecycle.
 */
export function getPrefetchInjectionsPath(sessionId: string, cacheDir: string): string {
  return join(injectionsDir(cacheDir), `${sessionId}.json`);
}

/**
 * Persist the injections recorded by a prefetch so the next sync-turn (a
 * separate subprocess) can attribute telemetry. A blank session id or empty
 * list is a no-op — there is nothing to hand off. The write is atomic
 * (temp-file + rename) and serialized behind a file lock so concurrent
 * subprocesses never interleave partial writes.
 */
export async function savePrefetchInjections(
  sessionId: string,
  cacheDir: string,
  injections: PrefetchInjection[],
): Promise<void> {
  if (!sessionId || injections.length === 0) return;

  // The lock is a mkdir of `<path>.lock` (non-recursive in memex-core), so the
  // containing dir MUST exist before acquiring it — otherwise acquireLock spins
  // for its full timeout on ENOENT. Create it up front.
  const dir = injectionsDir(cacheDir);
  await mkdir(dir, { recursive: true });
  const path = getPrefetchInjectionsPath(sessionId, cacheDir);
  await withFileLock(path, async () => {
    const tmpPath = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmpPath, JSON.stringify(injections), "utf-8");
    await rename(tmpPath, path);
  });
}

/**
 * Load AND clear the pending injections for a session (take-once semantics):
 * sync-turn consumes them exactly once so a later turn never double-counts the
 * same attribution. A missing / empty / unparseable file yields `[]`.
 */
export async function takePersistedPrefetchInjections(
  sessionId: string,
  cacheDir: string,
): Promise<PrefetchInjection[]> {
  if (!sessionId) return [];

  // Ensure the containing dir exists before the lock mkdir (see
  // savePrefetchInjections): a missing parent makes acquireLock spin on ENOENT.
  await mkdir(injectionsDir(cacheDir), { recursive: true });
  const path = getPrefetchInjectionsPath(sessionId, cacheDir);
  return withFileLock(path, async () => {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return [];
    }
    // Delete first so a parse failure can't leave a poison file behind.
    await rm(path, { force: true });
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isInjectionArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function injectionsDir(cacheDir: string): string {
  return join(cacheDir, "prefetch-injections");
}

function isInjectionArray(value: unknown): value is PrefetchInjection[] {
  return (
    Array.isArray(value) &&
    value.every(
      (v) =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as PrefetchInjection).location === "string" &&
        typeof (v as PrefetchInjection).bestQueryIndex === "number",
    )
  );
}
