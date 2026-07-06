// Cross-adapter location-handle conformance guard (memex-core#32 freeze-SHA memo).

import {
  buildScanRoots,
  decodePortableLocation,
  encodePortableLocation,
  type ScanRootContext,
} from "@jim80net/memex-core";
import { describe, expect, it } from "vitest";
import { LOCATION_ROUND_TRIP_GOLDEN } from "../fixtures/cross-adapter/location-round-trip-golden.ts";

const FIXTURE_CTX: ScanRootContext = {
  cwd: "/home/user/project",
  syncEnabled: true,
  syncRepoDir: "/home/user/.memex/sync",
  globalSkillsDirs: ["/home/user/.grok/skills", "/home/user/.claude/skills"],
  globalRulesDirs: ["/home/user/.grok/rules"],
  projectSkillsDir: "/home/user/project/.grok/skills",
  projectRulesDir: "/home/user/project/.grok/rules",
  harness: "grok",
};

function fixtureRegistry() {
  return buildScanRoots(FIXTURE_CTX, {
    skillDirs: [
      "/home/user/.grok/skills",
      "/home/user/project/.grok/skills",
      "/home/user/.memex/sync/skills",
      "/opt/extra/skills",
    ],
    memoryDirs: ["/home/user/project/.grok/memories"],
    ruleDirs: ["/home/user/.grok/rules", "/home/user/.memex/sync/rules"],
  });
}

describe("location round-trip golden (memex-core#32 conformance)", () => {
  it("round-trips golden vectors against pinned memex-core", () => {
    const registry = fixtureRegistry();
    for (const { absolute, handle } of LOCATION_ROUND_TRIP_GOLDEN) {
      expect(encodePortableLocation(registry, absolute)).toBe(handle);
      expect(decodePortableLocation(registry, handle)).toBe(absolute);
    }
  });
});
