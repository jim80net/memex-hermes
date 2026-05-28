// Hermes.tool-remember — write a memory entry into the project memory dir
// (NOT MEMORY.md), report `{written, synced}`.
//
// `synced` is true only when sync.enabled AND the project ID is not in the
// `_session/*` namespace. An explicit `projectName` promotes the write into
// the named project — D7 / memex-tool-surface "Promotion to a named project
// via memex_remember".

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type {
  HermesToolRememberArgs,
  HermesToolRememberOutput,
  HermesToolScope,
} from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import { isSessionProjectId, resolveHermesProjectId } from "../core/sync-helpers.ts";
import { getState } from "../state.ts";

export async function handleToolRemember(
  args: HermesToolRememberArgs | undefined,
  cwd: string,
  config: HermesConfig,
  paths: HermesPaths,
  logger?: Logger,
): Promise<HermesToolRememberOutput> {
  if (!args?.content || args.content.trim().length === 0) {
    throw new Error("memex_remember: content is required");
  }

  const scope: HermesToolScope = args.scope ?? config.tools.memex_remember.defaultScope;
  const state = getState();

  const { targetDir, projectId } = await resolveTargetDir(
    scope,
    args.projectName,
    cwd,
    state.sessionId,
    config,
    paths,
  );
  await mkdir(targetDir, { recursive: true });

  const slug = slugify(extractTitle(args.content));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(2).toString("hex");
  const filename = `memex-remember-${ts}-${slug}-${suffix}.md`;
  const filePath = join(targetDir, filename);

  const body = formatMemory(args.content);
  await writeFile(filePath, body, "utf-8");

  const synced =
    config.sync.enabled &&
    config.sync.repo.length > 0 &&
    (projectId === null || !isSessionProjectId(projectId));

  logger?.info(`memex-hermes[remember]: wrote ${filePath} synced=${synced}`);

  return { written: filePath, synced };
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

async function resolveTargetDir(
  scope: HermesToolScope,
  projectName: string | undefined,
  cwd: string,
  sessionId: string,
  config: HermesConfig,
  paths: HermesPaths,
): Promise<{ targetDir: string; projectId: string | null }> {
  if (projectName && projectName.length > 0) {
    const projectId = projectName;
    return {
      targetDir: join(paths.syncRepoDir, "projects", projectId, "memory"),
      projectId,
    };
  }

  if (scope === "global") {
    return {
      targetDir: join(paths.syncRepoDir, "global", "memory"),
      projectId: null,
    };
  }

  if (scope === "session") {
    const projectId = `_session/${sessionId || "unknown"}`;
    return {
      targetDir: join(paths.syncRepoDir, "projects", projectId, "memory"),
      projectId,
    };
  }

  // project scope (default)
  const projectId = await resolveHermesProjectId(cwd, sessionId, config.sync);
  return {
    targetDir: join(paths.syncRepoDir, "projects", projectId, "memory"),
    projectId,
  };
}

function formatMemory(content: string): string {
  const name = slugify(extractTitle(content));
  const description = extractDescription(content);
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "type: memory",
    "---",
    "",
    content.trim(),
    "",
  ].join("\n");
}

function extractTitle(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0] ?? "memory";
  return firstLine.replace(/^#+\s*/, "").slice(0, 80);
}

function extractDescription(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0] ?? "";
  return firstLine
    .replace(/^#+\s*/, "")
    .replace(/"/g, "'")
    .slice(0, 200);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "memory"
  );
}
