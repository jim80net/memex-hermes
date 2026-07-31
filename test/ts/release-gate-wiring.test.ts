import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function read(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf-8");
}

describe("required release gate wiring", () => {
  it("keeps all release-surface checks in the reusable workflow", async () => {
    const gate = await read(".github/workflows/required-release-gate.yml");

    expect(gate).toContain("workflow_call:");
    expect(gate).toContain("pnpm audit:prod");
    expect(gate).toContain("pnpm gate:runtime");
    expect(gate).toContain("python -m build --wheel");
    expect(gate).toContain("memex-hermes-install");
  });

  it("makes normal CI call the reusable gate", async () => {
    const ci = await read(".github/workflows/ci.yml");

    expect(ci).toMatch(
      /release-gate:\n(?:\s+.*\n)*?\s+uses: \.\/\.github\/workflows\/required-release-gate\.yml/,
    );
  });

  it("mechanically dispatches the required gate for bot-created release PRs", async () => {
    const ci = await read(".github/workflows/ci.yml");
    const release = await read(".github/workflows/release-please.yml");

    expect(ci).toContain("workflow_dispatch:");
    expect(ci).toMatch(
      /release-gate:\n\s+if: github\.event_name == 'pull_request' \|\| github\.event_name == 'workflow_dispatch'/,
    );
    expect(release).toMatch(/release-please:\n(?:\s+.*\n)*?\s+actions: write/);
    expect(release).toContain("if: steps.release.outputs.prs_created == 'true'");
    expect(release).toContain('gh workflow run ci.yml --ref "$branch"');
  });

  it("blocks release creation and publishing on the reusable gate", async () => {
    const release = await read(".github/workflows/release-please.yml");

    expect(release).toMatch(
      /release-gate:\n(?:\s+.*\n)*?\s+uses: \.\/\.github\/workflows\/required-release-gate\.yml/,
    );
    expect(release).toMatch(/release-please:\n\s+needs: release-gate/);
    expect(release).toMatch(/build:\n\s+needs: \[release-gate, release-please\]/);
    expect(release).toMatch(/publish-binaries:\n\s+needs: \[release-gate, release-please, build\]/);
    expect(release).toMatch(/publish-pypi:\n\s+needs: \[release-gate, release-please\]/);
  });
});
