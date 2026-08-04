#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const DEFAULT_MAX_ATTEMPTS = 30;
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

export async function approveReleasePrCi({
  releasePr,
  repository,
  getHeadSha,
  listRuns,
  approveRun,
  dispatchCi,
  sleep,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const parsed = typeof releasePr === "string" ? JSON.parse(releasePr) : releasePr;
  const number = parsed?.number;
  const branch = parsed?.headBranchName;
  if (!Number.isInteger(number) || typeof branch !== "string" || branch.length === 0) {
    throw new Error("release-please output did not include a PR number and head branch");
  }

  const headSha = await getHeadSha(repository, number);
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error(`release PR #${number} did not resolve to a head SHA`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const runs = await listRuns(repository, headSha);
    const exactPrRuns = runs.filter(
      (run) =>
        run?.event === "pull_request" &&
        run?.head_sha === headSha &&
        run?.path === CI_WORKFLOW_PATH,
    );
    const held = exactPrRuns.find(
      (run) => run?.status === "action_required" || run?.conclusion === "action_required",
    );
    if (held) {
      await approveRun(repository, held.id);
      return { approvedRunId: held.id, branch, headSha, number };
    }

    // GitHub can expose the exact PR run as requested/queued before its held
    // action_required state becomes queryable. Keep polling client-side rather
    // than asking the API to hide every not-yet-held state.
    const preApproval = exactPrRuns.find((run) =>
      ["requested", "queued", "waiting", "pending"].includes(run?.status),
    );
    if (!preApproval) {
      // If another actor already approved the exact PR suite, our job is done;
      // its own required contexts will independently decide pass/fail.
      const alreadyUnheld = exactPrRuns.find((run) =>
        ["in_progress", "completed"].includes(run?.status),
      );
      if (alreadyUnheld) {
        return { observedRunId: alreadyUnheld.id, branch, headSha, number };
      }
    }

    if (attempt < maxAttempts) await sleep(pollIntervalMs);
  }

  // Keep the old dispatch as observability/a diagnostic run, but fail this job:
  // a workflow_dispatch suite on the same SHA does not satisfy PR-required checks.
  await dispatchCi(repository, branch);
  throw new Error(
    `no held pull_request CI run found for release PR #${number} at ${headSha}; ` +
      "dispatched diagnostic CI, which does not satisfy the PR merge gate",
  );
}

export function createGhClient(exec = execFileSync) {
  const json = (args) => {
    const output = exec("gh", args, { encoding: "utf-8" });
    return output.length > 0 ? JSON.parse(output) : {};
  };

  return {
    getHeadSha: async (repository, number) =>
      json(["api", `repos/${repository}/pulls/${number}`]).head?.sha,
    listRuns: async (repository, headSha) =>
      json([
        "api",
        "--method",
        "GET",
        `repos/${repository}/actions/runs`,
        "-f",
        "event=pull_request",
        "-f",
        `head_sha=${headSha}`,
        "-f",
        "per_page=100",
      ]).workflow_runs ?? [],
    approveRun: async (repository, runId) => {
      exec("gh", ["api", "--method", "POST", `repos/${repository}/actions/runs/${runId}/approve`], {
        encoding: "utf-8",
      });
    },
    dispatchCi: async (repository, branch) => {
      exec("gh", ["workflow", "run", "ci.yml", "--ref", branch, "--repo", repository], {
        encoding: "utf-8",
      });
    },
  };
}

async function run() {
  const gh = createGhClient();
  const result = await approveReleasePrCi({
    releasePr: process.env.RELEASE_PR ?? "",
    repository: process.env.GITHUB_REPOSITORY ?? "",
    getHeadSha: gh.getHeadSha,
    listRuns: gh.listRuns,
    approveRun: gh.approveRun,
    dispatchCi: gh.dispatchCi,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  });
  process.stdout.write(
    result.approvedRunId
      ? `approved held CI run ${result.approvedRunId} for release PR #${result.number} at ${result.headSha}\n`
      : `release PR #${result.number} CI run ${result.observedRunId} was already unheld at ${result.headSha}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
