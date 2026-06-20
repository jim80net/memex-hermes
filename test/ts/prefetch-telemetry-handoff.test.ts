// P2-2 — prefetch → sync-turn telemetry attribution must cross the subprocess
// boundary.
//
// Hermes.prefetch records the entries it injected; the attribution
// (recordMatch) is deferred to the NEXT Hermes.sync-turn, which is when the
// model has actually observed the injection. Because each event runs in a
// separate single-shot binary process, the handoff cannot live in in-process
// state — it is persisted to a per-session file under the cache dir and
// consumed (take-once) by sync-turn. These tests simulate the process boundary
// by calling resetState() between the prefetch write and the sync-turn read.

import { mkdir, rm } from "node:fs/promises";
import { getEntryTelemetry, loadTelemetry } from "@jim80net/memex-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import {
  getPrefetchInjectionsPath,
  savePrefetchInjections,
  takePersistedPrefetchInjections,
} from "../../src/core/prefetch-injections.ts";
import { handleSyncTurn } from "../../src/hooks/sync-turn.ts";
import { resetState } from "../../src/state.ts";
import { makeFakePaths, makeTmpRoot } from "./_helpers.ts";

describe("prefetch → sync-turn telemetry handoff (P2-2)", () => {
  let root: string;
  let paths: ReturnType<typeof makeFakePaths>;

  beforeEach(async () => {
    resetState();
    root = await makeTmpRoot();
    paths = makeFakePaths(root);
    await mkdir(paths.cacheDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sync-turn attributes telemetry for injections persisted by a prior (separate) prefetch", async () => {
    // Prefetch subprocess: persist the injected set, then "exit" (resetState
    // drops the in-process buffer, simulating the process boundary).
    await savePrefetchInjections("s-handoff", paths.cacheDir, [
      { location: "/skills/a/SKILL.md", bestQueryIndex: 0 },
      { location: "/skills/b/SKILL.md", bestQueryIndex: 1 },
    ]);
    resetState();

    // sync-turn subprocess: no in-process buffer; it must read from disk.
    await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s-handoff" },
      root,
      DEFAULT_CONFIG,
      paths,
    );

    const telemetry = await loadTelemetry(paths.telemetryPath);
    expect(getEntryTelemetry(telemetry, "/skills/a/SKILL.md")?.matchCount).toBe(1);
    expect(getEntryTelemetry(telemetry, "/skills/b/SKILL.md")?.matchCount).toBe(1);
  });

  it("consumed injections are cleared — a second sync-turn does not double-count", async () => {
    await savePrefetchInjections("s-once", paths.cacheDir, [
      { location: "/skills/c/SKILL.md", bestQueryIndex: 0 },
    ]);
    resetState();

    await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s-once" },
      root,
      DEFAULT_CONFIG,
      paths,
    );
    resetState();
    // Second turn with no new prefetch — file is gone, nothing to attribute.
    await handleSyncTurn(
      { user_content: "u2", assistant_content: "a2", session_id: "s-once" },
      root,
      DEFAULT_CONFIG,
      paths,
    );

    const telemetry = await loadTelemetry(paths.telemetryPath);
    expect(getEntryTelemetry(telemetry, "/skills/c/SKILL.md")?.matchCount).toBe(1);
  });

  it("takePersistedPrefetchInjections deletes the file after reading (take-once)", async () => {
    await savePrefetchInjections("s-take", paths.cacheDir, [
      { location: "/skills/d/SKILL.md", bestQueryIndex: 2 },
    ]);

    const first = await takePersistedPrefetchInjections("s-take", paths.cacheDir);
    expect(first).toEqual([{ location: "/skills/d/SKILL.md", bestQueryIndex: 2 }]);

    const second = await takePersistedPrefetchInjections("s-take", paths.cacheDir);
    expect(second).toEqual([]);
  });

  it("a missing injections file is a benign no-op", async () => {
    const out = await takePersistedPrefetchInjections("s-none", paths.cacheDir);
    expect(out).toEqual([]);
    // sync-turn over an empty handoff records nothing and still returns ok.
    const result = await handleSyncTurn(
      { user_content: "u", assistant_content: "a", session_id: "s-none" },
      root,
      DEFAULT_CONFIG,
      paths,
    );
    expect(result.ok).toBe(true);
  });

  it("savePrefetchInjections no-ops on empty list / blank session", async () => {
    await savePrefetchInjections("s-empty", paths.cacheDir, []);
    await savePrefetchInjections("", paths.cacheDir, [{ location: "/x", bestQueryIndex: 0 }]);
    // Neither wrote a file.
    expect(await takePersistedPrefetchInjections("s-empty", paths.cacheDir)).toEqual([]);
    // getPrefetchInjectionsPath for blank session is under the dir but file absent.
    expect(getPrefetchInjectionsPath("s-empty", paths.cacheDir)).toContain("prefetch-injections");
  });
});
