// Hermes.tool-remember — write a memory entry into the project memory dir
// (NOT MEMORY.md), then commit + (gated) push it; report `{written, committed,
// synced}`.
//
// `synced` is a CONFIRMATION — true only when the entry was committed AND pushed
// to the remote on this call (sync.enabled + a configured repo + a push-eligible
// project id + autoCommitPush + the push succeeded). `committed` is true when the
// entry was committed to the local sync repo; a `committed:true, synced:false`
// result means it is committed locally and will ride the next successful push by
// any writer (#6). The commit + push go through the shared `commitAndMaybePush`
// policy (same path session-end uses). An explicit `projectName` promotes the
// write into the named project — D7 / memex-tool-surface "Promotion to a named
// project via memex_remember".

import { randomBytes } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { Logger } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type {
  HermesToolRememberArgs,
  HermesToolRememberOutput,
  HermesToolScope,
} from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import { formatMemoryEntry } from "../core/memory-format.ts";
import { commitAndMaybePush, resolveHermesProjectId } from "../core/sync-helpers.ts";
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
  // Lexical containment (above) catches `..`; it cannot catch a SYMLINK in the
  // path that points outside the repo. Now that the dir exists, realpath both
  // sides and re-check — refuse to write a file through a symlink escape before
  // any content is written.
  await assertRealpathWithinSyncRepo(targetDir, paths.syncRepoDir);

  const slug = slugify(extractTitle(args.content));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(2).toString("hex");
  const filename = `memex-remember-${ts}-${slug}-${suffix}.md`;
  const filePath = join(targetDir, filename);

  const body = formatMemory(args.content);
  await writeFile(filePath, body, "utf-8");

  // Commit + push the entry via the shared policy. The sync-turn mtime-watcher
  // only watches MEMORY.md/USER.md, so without this a memex-remember-*.md never
  // reached the remote — `synced` was an eligibility prediction, not a fact.
  // Commit only this file (its repo-relative path) so a concurrent writer's
  // staged changes are never swept in.
  const result = await commitAndMaybePush({
    syncRepoDir: paths.syncRepoDir,
    addPaths: [relative(paths.syncRepoDir, filePath)],
    message: `memex-hermes memex_remember: ${projectId ?? "global"}`,
    projectId,
    sync: config.sync,
    logger,
  });

  logger?.info(
    `memex-hermes[remember]: wrote ${filePath} committed=${result.committed} synced=${result.pushed}`,
  );

  return { written: filePath, committed: result.committed, synced: result.pushed };
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

/**
 * Symlink-aware containment: resolve symlinks on BOTH the sync-repo root and the
 * (now-existing) target dir, then re-check containment. A lexical resolve()
 * cannot detect a symlink in the path that points outside the repo; realpath
 * can. Called after mkdir so the target exists; throws before any file write.
 */
async function assertRealpathWithinSyncRepo(targetDir: string, syncRepoDir: string): Promise<void> {
  const root = await realpath(syncRepoDir);
  const real = await realpath(targetDir);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(
      `memex_remember: refusing to write through a symlink outside the sync repo (resolved to ${real})`,
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
  // The frontmatter block is the shared cross-adapter format (memory-format.ts).
  // The body trim stays HERE (the caller owns body normalization); the formatter
  // treats body as opaque, so this path's on-disk bytes are unchanged by the
  // extraction. name is slug-safe ([a-z0-9-]); description is the first content
  // line and may carry a colon/quote — the shared formatter escapes both.
  return formatMemoryEntry({
    name: slugify(extractTitle(content)),
    description: extractDescription(content),
    type: "memory",
    body: content.trim(),
  });
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
