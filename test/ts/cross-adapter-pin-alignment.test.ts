// Cross-adapter version-pin alignment guard (issue #4) — Tier 2.
//
// The embedding cache (memex-cache.json) and the embedding vectors it stores are
// regenerable derivatives of the memory-file text (loadCache discards on
// version/embeddingModel mismatch and re-embeds), so this guard is NOT a
// corpus-survival requirement — it protects WARM-CACHE REUSE and RANKING
// STABILITY across adapters. Two adapters that link different
// @huggingface/transformers versions produce different vectors for the same text
// under the same `embeddingModel` string; loadCache cannot detect that (version
// + model match), so a cache written by one and read by the other would carry
// subtly wrong vectors → silent ranking drift. This guard makes such a drift
// fail loudly instead.
//
// SELF-CONTAINED: no live memex-claude. The reference values are committed
// constants (sourced from memex-claude's package.json, read 2026-06-23), and the
// resolved/installed versions are read from this repo's own node_modules.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// --- Cross-adapter reference (KEEP IN LOCKSTEP WITH memex-claude + memex-core) -
// Provenance: memex-claude/package.json + both pnpm-lock.yaml files, read
// 2026-06-23 — all three repos resolve transformers 3.8.1 / memex-core 0.4.0.
// When memex-claude bumps either, bump here in the same change.
const CROSS_ADAPTER_TRANSFORMERS_RANGE = "^3.8.1";
const CROSS_ADAPTER_TRANSFORMERS_RESOLVED = "3.8.1";
// Published-artifact baseline: adapters align on memex-core@^0.7.0.
const CROSS_ADAPTER_MEMEX_CORE_RANGE = "^0.7.0";
const CROSS_ADAPTER_MEMEX_CORE_RESOLVED = "0.7.0";

function readJson(relFromRepoRoot: string): Record<string, unknown> {
  // test/ts/<file> → repo root is two levels up.
  const url = new URL(`../../${relFromRepoRoot}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as Record<string, unknown>;
}

function depRange(pkg: Record<string, unknown>, name: string): string | undefined {
  // A range may live in any dependency class — read across all three. memex-core
  // declares @huggingface/transformers under optionalDependencies, not
  // dependencies, so a naive `pkg.dependencies[name]` read would be undefined.
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const block = pkg[field];
    if (block && typeof block === "object") {
      const v = (block as Record<string, string>)[name];
      if (typeof v === "string") return v;
    }
  }
  return undefined;
}

describe("cross-adapter version-pin alignment (#4 / Tier 2)", () => {
  const hermesPkg = readJson("package.json");

  describe("declared ranges match the cross-adapter reference (documentary)", () => {
    it("@huggingface/transformers range", () => {
      expect(depRange(hermesPkg, "@huggingface/transformers")).toBe(
        CROSS_ADAPTER_TRANSFORMERS_RANGE,
      );
    });
    it("@jim80net/memex-core range", () => {
      expect(depRange(hermesPkg, "@jim80net/memex-core")).toBe(CROSS_ADAPTER_MEMEX_CORE_RANGE);
    });
  });

  describe("resolved/installed versions match (load-bearing)", () => {
    it("the INSTALLED @huggingface/transformers version equals the reference", () => {
      // The caret range can resolve to a different installed version; it is the
      // installed (bundled) version that determines the embedding vector space.
      const installed = readJson("node_modules/@huggingface/transformers/package.json");
      expect(installed.version).toBe(CROSS_ADAPTER_TRANSFORMERS_RESOLVED);
    });

    it("the INSTALLED @jim80net/memex-core version equals the reference", () => {
      const installed = readJson("node_modules/@jim80net/memex-core/package.json");
      expect(installed.version).toBe(CROSS_ADAPTER_MEMEX_CORE_RESOLVED);
    });

    it("memex-hermes's transformers range equals the INSTALLED memex-core's range", () => {
      // The shared embedding engine is memex-core's; if memex-core bumps its
      // transformers pin in a release and hermes's direct pin does not follow,
      // the bundle could resolve a vector space memex-core was not built against.
      const corePkg = readJson("node_modules/@jim80net/memex-core/package.json");
      const coreRange = depRange(corePkg, "@huggingface/transformers");
      expect(coreRange, "@huggingface/transformers missing from memex-core pkg").toBeDefined();
      expect(depRange(hermesPkg, "@huggingface/transformers")).toBe(coreRange);
    });
  });
});
