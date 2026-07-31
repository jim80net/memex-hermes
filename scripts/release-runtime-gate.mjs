#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalEmbeddingProvider } from "@jim80net/memex-core";
import { assertReleaseEmbeddingVector } from "./release-gate-contract.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const coreManifest = JSON.parse(
  readFileSync(join(repoRoot, "node_modules/@jim80net/memex-core/package.json"), "utf-8"),
);

const hostileRoot = mkdtempSync(join(tmpdir(), "memex-hermes-hostile-sharp-"));
try {
  writeFileSync(
    join(hostileRoot, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: { "@jim80net/memex-core": coreManifest.version },
        overrides: { sharp: "0.34.5" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(hostileRoot, "probe.mjs"),
    `import { createRequire } from "node:module";
import { LocalEmbeddingProvider } from "@jim80net/memex-core";

const require = createRequire(import.meta.url);
const before = new Set(Object.keys(require.cache));
let message = "";
try {
  await new LocalEmbeddingProvider().embed(["hostile graph rejection probe"]);
  throw new Error("hostile Sharp graph unexpectedly initialized an embedding");
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
const newlyLoadedSharp = Object.keys(require.cache).filter(
  (path) =>
    /(?:sharp|@img)[/\\\\]/.test(path) &&
    !path.endsWith("sharp/package.json") &&
    !before.has(path),
);
const guardRejected =
  /vulnerable sharp 0\\.34\\.5.*sharp >=0\\.35\\.0.*GHSA-f88m-g3jw-g9cj/.test(message);
if (!guardRejected || newlyLoadedSharp.length !== 0) {
  console.error(JSON.stringify({ gate: "hostile-graph", guardRejected, message, newlyLoadedSharp }));
  process.exit(1);
}
console.log(JSON.stringify({ gate: "hostile-graph", ok: true, message, newlyLoadedSharp }));
`,
  );

  execFileSync("npm", ["install", "--ignore-scripts=false", "--no-audit", "--no-fund"], {
    cwd: hostileRoot,
    stdio: "inherit",
  });
  const probe = spawnSync(process.execPath, ["probe.mjs"], {
    cwd: hostileRoot,
    encoding: "utf-8",
  });
  if (probe.stdout) process.stdout.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
  if (probe.status !== 0) {
    throw new Error(`hostile graph probe failed with exit ${probe.status ?? "unknown"}`);
  }
} finally {
  rmSync(hostileRoot, { recursive: true, force: true });
}

const modelCache =
  process.env.MEMEX_RELEASE_GATE_MODEL_CACHE ??
  join(tmpdir(), "memex-hermes-release-gate-models");
const retryDelaysMs = [5_000, 10_000, 20_000, 40_000, 60_000];
let vectors;
for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
  try {
    vectors = await new LocalEmbeddingProvider(undefined, modelCache).embed([
      "Hermes required release gate",
    ]);
    break;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = /(?:429|fetch|trying to load file)/i.test(message);
    if (!retryable || attempt === retryDelaysMs.length) throw error;
    const delayMs = retryDelaysMs[attempt];
    console.warn(
      `real embedding fetch attempt ${attempt + 1} failed; retrying in ${delayMs / 1000}s: ${message}`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

const vector = assertReleaseEmbeddingVector(vectors?.[0]);
console.log(JSON.stringify({ gate: "real-embedding", ok: true, dimensions: vector.length }));
