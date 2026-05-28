// Persistent mtime tracker for the MEMORY.md/USER.md mtime-watcher inside
// Hermes.sync-turn. Survives subprocess boundaries by living in
// `<cacheDir>/memory-mtimes.json`. All writes are serialized behind a file
// lock per F8 / G19.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "@jim80net/memex-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryMtimesData {
  version: 1;
  mtimes: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

export async function loadMemoryMtimes(path: string): Promise<MemoryMtimesData> {
  const empty: MemoryMtimesData = { version: 1, mtimes: {} };
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as MemoryMtimesData;
    if (data.version !== 1 || typeof data.mtimes !== "object" || data.mtimes === null) {
      return empty;
    }
    return data;
  } catch {
    return empty;
  }
}

export async function saveMemoryMtimes(path: string, data: MemoryMtimesData): Promise<void> {
  // mkdir BEFORE acquiring the lock — the lock is a non-recursive mkdir of
  // `<path>.lock`, so the parent dir must already exist or acquireLock spins
  // for 5 s before fallback.
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(path, async () => {
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(data), "utf-8");
    await rename(tmp, path);
  });
}
