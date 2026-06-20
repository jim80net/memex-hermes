// P3-6 — the set of release platforms must agree across all three places that
// encode it, or a declared-but-unbuilt target 404s at install time:
//
//   1. build.ts          — PLATFORMS map (what the build script can produce)
//   2. release-please.yml — the `build` job matrix (what CI actually builds)
//   3. bin/install.sh     — the supported-platform allowlist (what install
//                           offers to download)
//
// This test reads the three files and asserts identical platform sets. It is
// the durable guard against the drift that left darwin-x64 / win32-arm64
// declared in build.ts but unbuilt by CI (so bin/install.sh 404'd for them).

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function read(rel: string): Promise<string> {
  return readFile(join(repoRoot, rel), "utf-8");
}

describe("release platform matrix is consistent across build.ts, CI, and install.sh (P3-6)", () => {
  it("build.ts PLATFORMS == release-please.yml matrix == install.sh allowlist", async () => {
    const [buildTs, workflow, installSh] = await Promise.all([
      read("build.ts"),
      read(".github/workflows/release-please.yml"),
      read("bin/install.sh"),
    ]);

    // 1. build.ts: keys of the PLATFORMS object literal ("linux-x64": { ... }).
    const buildPlatforms = new Set(
      [...buildTs.matchAll(/"((?:linux|darwin|win32)-(?:x64|arm64))":\s*\{/g)].map((m) => m[1]),
    );

    // 2. workflow: the `platform:` entries of the build matrix.
    const matrixPlatforms = new Set(
      [...workflow.matchAll(/platform:\s*((?:linux|darwin|win32)-(?:x64|arm64))/g)].map(
        (m) => m[1],
      ),
    );

    // 3. install.sh: the case allowlist line `linux-x64|...|win32-x64) ;;` —
    //    scoped to that exact line so the comment/echo mentions don't mask a
    //    wrong allowlist.
    const allowlistLine = installSh
      .split("\n")
      .find((l) => /^\s*(?:linux|darwin|win32)-(?:x64|arm64)(?:\|[a-z0-9-]+)*\)\s*;;/.test(l));
    expect(allowlistLine, "install.sh case allowlist line not found").toBeTruthy();
    const installPlatforms = new Set(
      [...(allowlistLine ?? "").matchAll(/(?:linux|darwin|win32)-(?:x64|arm64)/g)].map((m) => m[0]),
    );

    // Sanity: each source produced a non-trivial set.
    expect(buildPlatforms.size).toBeGreaterThanOrEqual(4);
    expect(matrixPlatforms.size).toBeGreaterThanOrEqual(4);
    expect(installPlatforms.size).toBeGreaterThanOrEqual(4);

    const sorted = (s: Set<string>) => [...s].sort();
    expect(sorted(matrixPlatforms)).toEqual(sorted(buildPlatforms));
    expect(sorted(installPlatforms)).toEqual(sorted(buildPlatforms));
  });
});
