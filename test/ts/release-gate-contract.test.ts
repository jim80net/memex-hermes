import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractUrl = pathToFileURL(join(repoRoot, "scripts/release-gate-contract.mjs")).href;

describe("release embedding contract", () => {
  it("rejects a finite vector that is not exactly 384-dimensional", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { assertReleaseEmbeddingVector } from ${JSON.stringify(contractUrl)};
assertReleaseEmbeddingVector(Array(383).fill(0));`,
        ],
        { stdio: "pipe" },
      ),
    ).toThrow(/exactly 384 finite values/);
  });
});
