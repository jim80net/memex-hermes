import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@jim80net/memex-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../../src/core/config.ts";

function captureLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (m) => warnings.push(m),
    error: () => {},
  };
  return { logger, warnings };
}

describe("DEFAULT_CONFIG", () => {
  it("has no ruleDirs field (rules live in the skills dir, C5)", () => {
    expect("ruleDirs" in DEFAULT_CONFIG).toBe(false);
  });

  it("suppresses session IDs and retries pushes by default (C12 / F9)", () => {
    expect(DEFAULT_CONFIG.sync.suppressSessionIds).toBe(true);
    expect(DEFAULT_CONFIG.sync.pushRetries).toBe(3);
  });

  it("mirrors Hermes memory by default", () => {
    expect(DEFAULT_CONFIG.mirrorHermesMemory).toBe(true);
  });
});

describe("mergeConfig", () => {
  it("returns defaults for an empty partial", () => {
    expect(mergeConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("does not mutate DEFAULT_CONFIG when nested sections are overridden", () => {
    mergeConfig({ sync: { enabled: true } as never, prefetch: { topK: 9 } as never });
    expect(DEFAULT_CONFIG.sync.enabled).toBe(false);
    expect(DEFAULT_CONFIG.prefetch.topK).toBe(3);
  });

  it("deep-merges the sync section, preserving unspecified fields", () => {
    const merged = mergeConfig({ sync: { enabled: true, repo: "git@x:y.git" } as never });
    expect(merged.sync.enabled).toBe(true);
    expect(merged.sync.repo).toBe("git@x:y.git");
    expect(merged.sync.suppressSessionIds).toBe(true);
    expect(merged.sync.pushRetries).toBe(3);
  });

  it("merges core fields through resolveCoreConfig", () => {
    const merged = mergeConfig({ embeddingModel: "custom/model", cacheTimeMs: 123 });
    expect(merged.embeddingModel).toBe("custom/model");
    expect(merged.cacheTimeMs).toBe(123);
  });

  it("merges prefetch and tools sections", () => {
    const merged = mergeConfig({
      prefetch: { topK: 7, threshold: 0.9 } as never,
      tools: { memex_search: { defaultLimit: 20 } } as never,
    });
    expect(merged.prefetch.topK).toBe(7);
    expect(merged.prefetch.threshold).toBe(0.9);
    expect(merged.prefetch.maxInjectedChars).toBe(8000);
    expect(merged.tools.memex_search.defaultLimit).toBe(20);
    expect(merged.tools.memex_search.enabled).toBe(true);
    expect(merged.tools.memex_recall.enabled).toBe(true);
  });

  it("merges mirrorHermesMemory boolean", () => {
    expect(mergeConfig({ mirrorHermesMemory: false }).mirrorHermesMemory).toBe(false);
  });
});

describe("loadConfig", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hermes-config-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns defaults when memex.json is missing (silent)", async () => {
    const { logger, warnings } = captureLogger();
    const cfg = await loadConfig(home, logger);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });

  it("loads and merges a valid memex.json", async () => {
    await writeFile(
      join(home, "memex.json"),
      JSON.stringify({ enabled: false, sync: { enabled: true, repo: "git@x:y.git" } }),
    );
    const cfg = await loadConfig(home);
    expect(cfg.enabled).toBe(false);
    expect(cfg.sync.enabled).toBe(true);
    expect(cfg.sync.repo).toBe("git@x:y.git");
    expect(cfg.sync.pushRetries).toBe(3);
  });

  it("tolerates malformed memex.json: logs a warning and uses defaults", async () => {
    await writeFile(join(home, "memex.json"), "{ this is not json");
    const { logger, warnings } = captureLogger();
    const cfg = await loadConfig(home, logger);
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("malformed memex.json");
  });
});
