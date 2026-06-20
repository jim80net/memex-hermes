#!/usr/bin/env bun
/**
 * Build script for memex-hermes standalone binaries.
 *
 * Compiles the TypeScript source at src/main.ts into a self-contained
 * executable using `bun build --compile`. The result lands at
 * dist/<platform>/memex-hermes[.exe]. The ONNX runtime shared library
 * is copied alongside the binary so the bin/memex wrapper can prepend
 * the install dir to LD_LIBRARY_PATH/DYLD_LIBRARY_PATH at exec time.
 *
 * Sharp is stubbed in node_modules before the bun bundle is built so
 * the native sharp module is not pulled into the artifact (we only
 * use the text-embedding pipeline from @huggingface/transformers; the
 * image pipelines that transitively depend on sharp are dead code at
 * compile time).
 *
 * Usage:
 *   bun run build.ts                            # build for current platform
 *   bun run build.ts --target bun-linux-x64    # cross-compile
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { arch, platform } from "node:os";

// Resolve the onnxruntime-node bin/napi-v3 directory regardless of
// whether pnpm, npm, or yarn put it there. The pnpm store directory
// (.pnpm/onnxruntime-node@<version>/...) is the common case; the flat
// path is the fallback for non-pnpm installs.
function resolveOnnxBase(): string {
  const pnpmBase = "node_modules/.pnpm";
  if (existsSync(pnpmBase)) {
    const entries = readdirSync(pnpmBase);
    const onnxDir = entries.find((e) => e.startsWith("onnxruntime-node@"));
    if (onnxDir) {
      return join(pnpmBase, onnxDir, "node_modules/onnxruntime-node/bin/napi-v3");
    }
  }
  return "node_modules/onnxruntime-node/bin/napi-v3";
}

const ONNX_BASE = resolveOnnxBase();
const SHARP_SYMLINK = "node_modules/.pnpm/@huggingface+transformers@3.8.1/node_modules/sharp";

interface PlatformFiles {
  onnxDir: string;
  sharedLibs: string[];
  binaryName: string;
}

// The DECLARED targets MUST match what the release CI actually builds
// (.github/workflows/release-please.yml `build` matrix) and what
// bin/install.sh advertises — otherwise a declared-but-unbuilt target 404s on
// install. The release matrix currently builds four targets; darwin-x64 (Intel
// Mac) and win32-arm64 are deliberately omitted here until the CI matrix builds
// them (they need a macos-13 Intel runner and a Windows-arm64 runner). To
// re-add: restore the entry below AND add the matching matrix include in
// release-please.yml AND the platform case in bin/install.sh.
const PLATFORMS: Record<string, PlatformFiles> = {
  "linux-x64": {
    onnxDir: join(ONNX_BASE, "linux/x64"),
    sharedLibs: ["libonnxruntime.so.1", "libonnxruntime_providers_shared.so"],
    binaryName: "memex-hermes",
  },
  "linux-arm64": {
    onnxDir: join(ONNX_BASE, "linux/arm64"),
    sharedLibs: ["libonnxruntime.so.1"],
    binaryName: "memex-hermes",
  },
  "darwin-arm64": {
    onnxDir: join(ONNX_BASE, "darwin/arm64"),
    sharedLibs: ["libonnxruntime.1.21.0.dylib"],
    binaryName: "memex-hermes",
  },
  "win32-x64": {
    onnxDir: join(ONNX_BASE, "win32/x64"),
    sharedLibs: ["onnxruntime.dll", "DirectML.dll"],
    binaryName: "memex-hermes.exe",
  },
};

function detectPlatformKey(): string {
  const p = platform();
  const a = arch();
  const key = `${p}-${a}`;
  if (!(key in PLATFORMS)) {
    console.error(`Unsupported platform: ${key}`);
    process.exit(1);
  }
  return key;
}

function parseBunTarget(target: string): string {
  // e.g. "bun-linux-x64" → "linux-x64"
  const match = target.match(/^bun-(linux|darwin|win(?:dows|32))-(x64|arm64)$/);
  if (!match) {
    console.error(`Invalid target: ${target}. Expected bun-{linux,darwin,windows}-{x64,arm64}`);
    process.exit(1);
  }
  const os = match[1] === "windows" ? "win32" : match[1];
  const key = `${os}-${match[2]}`;
  if (!(key in PLATFORMS)) {
    console.error(
      `Unsupported target: ${target} (${key}). Supported: ${Object.keys(PLATFORMS).join(", ")}. ` +
        `darwin-x64 / win32-arm64 are not built until the release CI matrix adds them.`,
    );
    process.exit(1);
  }
  return key;
}

// Parse args
const targetArg = process.argv.find((a) => a.startsWith("--target"));
let targetFlag: string | undefined;
let platformKey: string;

if (targetArg) {
  const idx = process.argv.indexOf(targetArg);
  targetFlag = targetArg.includes("=") ? targetArg.split("=")[1] : process.argv[idx + 1];
  platformKey = parseBunTarget(targetFlag);
} else {
  platformKey = detectPlatformKey();
}

const platConfig = PLATFORMS[platformKey];
const outDir = join("dist", platformKey);

console.log(`Building memex-hermes for ${platformKey}...`);

// 1. Stub sharp in node_modules so bun doesn't bundle native sharp.
let sharpOrigTarget: string | null = null;
if (existsSync(SHARP_SYMLINK)) {
  try {
    sharpOrigTarget = readlinkSync(SHARP_SYMLINK);
  } catch {
    // not a symlink, might already be stubbed
  }
  rmSync(SHARP_SYMLINK, { recursive: true, force: true });
}
mkdirSync(SHARP_SYMLINK, { recursive: true });
Bun.write(
  join(SHARP_SYMLINK, "package.json"),
  JSON.stringify({ name: "sharp", version: "0.0.0", main: "index.js" }),
);
Bun.write(join(SHARP_SYMLINK, "index.js"), "module.exports = {};");

try {
  // 2. Compile (inject version at compile time via --define).
  const pkgVersion = JSON.parse(readFileSync("package.json", "utf-8")).version;
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, platConfig.binaryName);
  const args = [
    "build",
    "--compile",
    "src/main.ts",
    "--outfile",
    outFile,
    "--define",
    `process.env.MEMEX_HERMES_VERSION='"${pkgVersion}"'`,
  ];
  if (targetFlag) {
    args.push("--target", targetFlag);
  }

  execSync(`bun ${args.join(" ")}`, { stdio: "inherit" });

  // 3. Copy ONNX shared libraries alongside binary.
  for (const lib of platConfig.sharedLibs) {
    const src = join(platConfig.onnxDir, lib);
    const dest = join(outDir, lib);
    if (existsSync(src)) {
      cpSync(src, dest);
      console.log(`  Copied ${lib}`);
    } else {
      console.warn(`  Warning: ${src} not found, skipping`);
    }
  }

  console.log(`\nBuild complete: ${outDir}/`);
} finally {
  // 4. Restore sharp symlink (or wipe the stub if there was no original).
  rmSync(SHARP_SYMLINK, { recursive: true, force: true });
  if (sharpOrigTarget) {
    symlinkSync(sharpOrigTarget, SHARP_SYMLINK);
    console.log("Restored sharp symlink");
  }
}
