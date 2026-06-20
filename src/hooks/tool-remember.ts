// Hermes.tool-remember — write a memory entry into the project memory dir
// (NOT MEMORY.md), report `{written, synced}`.
//
// `synced` is true only when sync.enabled AND the project ID is not in the
// `_session/*` namespace. An explicit `projectName` promotes the write into
// the named project — D7 / memex-tool-surface "Promotion to a named project
// via memex_remember".

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Logger } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type {
  HermesToolRememberArgs,
  HermesToolRememberOutput,
  HermesToolScope,
} from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import { isSessionProjectId, resolveHermesProjectId } from "../core/sync-helpers.ts";
import { safeYamlScalar } from "../core/yaml-frontmatter.ts";
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
  // Defense-in-depth across ALL scope branches: never write outside the sync
  // repo even if a projectId (e.g. a crafted projectName, or an unexpected
  // session id) contains path-traversal. `join` normalizes `..`, so resolving
  // and checking containment catches an escape regardless of the input shape.
  assertWithinSyncRepo(targetDir, paths.syncRepoDir);
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

/**
 * Validate an LLM/user-supplied `projectName` before it becomes a path segment.
 * A named project is a single identifier — it must not contain path separators,
 * a `..` traversal segment, a leading `~`, or a NUL. Rejecting these up front
 * gives a clear error; the resolved-containment check in handleToolRemember is
 * the backstop. Returns the validated name.
 */
function validateProjectName(projectName: string): string {
  const bad =
    projectName.includes("/") ||
    projectName.includes("\\") ||
    projectName.includes("\0") ||
    projectName.startsWith("~") ||
    projectName.split(/[/\\]/).includes("..") ||
    projectName === "." ||
    projectName === "..";
  if (bad) {
    throw new Error(
      `memex_remember: invalid projectName ${JSON.stringify(projectName)} ` +
        `(must not contain path separators, '..', or a leading '~')`,
    );
  }
  return projectName;
}

/**
 * Refuse to write outside the sync repo. `resolve` normalizes any `..` that
 * slipped through, so a target that escapes `syncRepoDir` is caught here for
 * every scope branch (path-traversal hardening).
 */
function assertWithinSyncRepo(targetDir: string, syncRepoDir: string): void {
  const root = resolve(syncRepoDir);
  const resolved = resolve(targetDir);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(
      `memex_remember: refusing to write outside the sync repo (resolved to ${resolved})`,
    );
  }
}

async function resolveTargetDir(
  scope: HermesToolScope,
  projectName: string | undefined,
  cwd: string,
  sessionId: string,
  config: HermesConfig,
  paths: HermesPaths,
): Promise<{ targetDir: string; projectId: string | null }> {
  if (projectName && projectName.length > 0) {
    const projectId = validateProjectName(projectName);
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
  // name is slug-safe ([a-z0-9-]), but description is the first content line and
  // may carry a colon/quote that would corrupt the frontmatter — emit both as
  // escaped double-quoted YAML scalars for a single, consistent safe path.
  return [
    "---",
    `name: ${safeYamlScalar(name)}`,
    `description: ${safeYamlScalar(description)}`,
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
