import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const helperUrl = pathToFileURL(join(repoRoot, "scripts/approve-release-pr-ci.mjs")).href;

function runProbe(source: string): string {
  return execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf-8",
  });
}

describe("release PR CI approval", () => {
  it("calls the held-run approval endpoint and scopes discovery to the PR head", () => {
    const output = runProbe(`
      import { createGhClient } from ${JSON.stringify(helperUrl)};
      const calls = [];
      const exec = (_command, args) => {
        calls.push(args);
        if (args[1]?.includes("/pulls/")) return JSON.stringify({ head: { sha: "7020664" } });
        if (args[2] === "GET") return JSON.stringify({ workflow_runs: [{ id: 12 }] });
        return "";
      };
      const gh = createGhClient(exec);
      const headSha = await gh.getHeadSha("jim80net/memex-hermes", 36);
      await gh.listRuns("jim80net/memex-hermes", headSha);
      await gh.approveRun("jim80net/memex-hermes", 12);
      console.log(JSON.stringify(calls));
    `);
    const calls = JSON.parse(output) as string[][];

    expect(calls[0]).toEqual(["api", "repos/jim80net/memex-hermes/pulls/36"]);
    expect(calls[1]).toContain("event=pull_request");
    expect(calls[1]).toContain("head_sha=7020664");
    expect(calls[1]).toContain("status=action_required");
    expect(calls[2]).toEqual([
      "api",
      "--method",
      "POST",
      "repos/jim80net/memex-hermes/actions/runs/12/approve",
    ]);
  });

  it("approves the held pull_request CI run for the exact release head", () => {
    const output = runProbe(`
      import { approveReleasePrCi } from ${JSON.stringify(helperUrl)};
      const calls = [];
      const result = await approveReleasePrCi({
        releasePr: { number: 36, headBranchName: "release-please--branches--main" },
        repository: "jim80net/memex-hermes",
        getHeadSha: async () => "7020664",
        listRuns: async () => [
          { id: 10, event: "workflow_dispatch", status: "completed", head_sha: "7020664", path: ".github/workflows/ci.yml" },
          { id: 11, event: "pull_request", status: "action_required", head_sha: "other", path: ".github/workflows/ci.yml" },
          { id: 12, event: "pull_request", status: "action_required", head_sha: "7020664", path: ".github/workflows/ci.yml" },
        ],
        approveRun: async (_repository, id) => calls.push(["approve", id]),
        dispatchCi: async () => calls.push(["dispatch"]),
        sleep: async () => {},
        maxAttempts: 1,
      });
      console.log(JSON.stringify({ calls, result }));
    `);
    const parsed = JSON.parse(output) as {
      calls: Array<[string, number?]>;
      result: { approvedRunId: number; headSha: string };
    };

    expect(parsed.calls).toEqual([["approve", 12]]);
    expect(parsed.result).toMatchObject({ approvedRunId: 12, headSha: "7020664" });
  });

  it("fails after diagnostic dispatch when no held PR suite exists", () => {
    const output = runProbe(`
      import { approveReleasePrCi } from ${JSON.stringify(helperUrl)};
      const calls = [];
      let failure = "";
      try {
        await approveReleasePrCi({
          releasePr: { number: 36, headBranchName: "release-please--branches--main" },
          repository: "jim80net/memex-hermes",
          getHeadSha: async () => "7020664",
          listRuns: async () => [],
          approveRun: async (_repository, id) => calls.push(["approve", id]),
          dispatchCi: async (_repository, branch) => calls.push(["dispatch", branch]),
          sleep: async () => {},
          maxAttempts: 2,
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      console.log(JSON.stringify({ calls, failure }));
    `);
    const parsed = JSON.parse(output) as {
      calls: Array<[string, string?]>;
      failure: string;
    };

    expect(parsed.calls).toEqual([["dispatch", "release-please--branches--main"]]);
    expect(parsed.failure).toMatch(/diagnostic CI, which does not satisfy the PR merge gate/);
  });
});
