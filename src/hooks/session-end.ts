// Hermes.session-end — extract learnings via an OpenAI-compatible chat
// completion to the explicitly configured `extractionModel`. v1 deliberately
// has no "use Hermes' active model" fallback (G17); when no model or no API
// key is configured, this is a no-op.
//
// Each learning is written as a `*.md` file with `type: session-learning`
// frontmatter under the project memory dir. Sync orchestration (commit/push)
// is delegated to mirrorAndCommit indirectly — we write the file then let
// the next Hermes.sync-turn pick the change up via the normal sync flow.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@jim80net/memex-core";
import { initSyncRepo } from "@jim80net/memex-core";
import type { HermesConfig } from "../core/config.ts";
import type { HermesSessionEndArgs, HermesSessionEndOutput } from "../core/envelope.ts";
import type { HermesPaths } from "../core/hermes-paths.ts";
import {
  detectBranch,
  isSessionProjectId,
  pushWithRetry,
  resolveHermesProjectId,
} from "../core/sync-helpers.ts";
import { safeYamlScalar } from "../core/yaml-frontmatter.ts";
import { getState } from "../state.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface ExtractedLearning {
  name: string;
  description: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export async function handleSessionEnd(
  args: HermesSessionEndArgs | undefined,
  cwd: string,
  config: HermesConfig,
  paths: HermesPaths,
  logger?: Logger,
): Promise<HermesSessionEndOutput> {
  if (!config.sessionEnd.extractLearnings) {
    return { written: 0 };
  }
  if (!config.sessionEnd.extractionModel) {
    logger?.info("memex-hermes[session-end]: extractionModel not set; skipping");
    return { written: 0 };
  }

  const messages = args?.messages ?? [];
  if (messages.length === 0) return { written: 0 };

  const learnings = await extractLearnings(messages, config, logger);
  if (learnings.length === 0) return { written: 0 };

  const state = getState();
  const projectId = await resolveHermesProjectId(cwd, state.sessionId, config.sync);
  const memoryDir = join(paths.syncRepoDir, "projects", projectId, "memory");
  await mkdir(memoryDir, { recursive: true });

  let written = 0;
  for (const learning of learnings) {
    const slug = slugify(learning.name);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `session-learning-${ts}-${slug}.md`;
    const filePath = join(memoryDir, filename);
    const fileBody = formatLearningFile(learning);
    try {
      await writeFile(filePath, fileBody, "utf-8");
      written++;
    } catch (err) {
      logger?.warn(`memex-hermes[session-end]: write ${filePath} failed: ${errMsg(err)}`);
    }
  }

  if (written > 0 && config.sync.enabled && config.sync.repo.length > 0) {
    let committed = false;
    try {
      await initSyncRepo(config.sync, paths.syncRepoDir);
      await runGit(["add", `projects/${projectId}/memory`], paths.syncRepoDir);
      await runGit(
        [
          "commit",
          "-m",
          `memex-hermes session-learnings: ${written} new entr${written === 1 ? "y" : "ies"}`,
        ],
        paths.syncRepoDir,
      );
      committed = true;
    } catch (err) {
      logger?.warn(`memex-hermes[session-end]: commit failed: ${errMsg(err)}`);
    }

    // Push the learnings to the remote. Without this they sat in the local
    // sync repo forever: the next sync-turn mtime-watcher only watches
    // MEMORY.md / USER.md, so session-learning-*.md never reached origin. Push
    // is suppressed for `_session/*` project IDs (D7 / C12) and gated on
    // autoCommitPush, mirroring the memory-write/mtime mirror path. Reuses the
    // shared rebase-retry + no-force-push helper.
    if (committed && config.sync.autoCommitPush && !isSessionProjectId(projectId)) {
      try {
        const branch = await detectBranch(paths.syncRepoDir);
        await pushWithRetry(
          paths.syncRepoDir,
          branch,
          { pushRetries: config.sync.pushRetries, baseBackoffMs: 200 },
          logger,
        );
      } catch (err) {
        logger?.warn(`memex-hermes[session-end]: push failed: ${errMsg(err)}`);
      }
    }
  }

  return { written };
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

async function extractLearnings(
  messages: ReadonlyArray<Readonly<Record<string, unknown>>>,
  config: HermesConfig,
  logger?: Logger,
): Promise<ExtractedLearning[]> {
  const apiKey = process.env.MEMEX_HERMES_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (apiKey.length === 0) {
    logger?.info("memex-hermes[session-end]: no API key in env; skipping extraction");
    return [];
  }
  const baseUrl =
    process.env.MEMEX_HERMES_LLM_BASE_URL ?? "https://api.openai.com/v1/chat/completions";

  const transcript = messages
    .map((m) => {
      const role = typeof m.role === "string" ? m.role : "unknown";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const chat: ChatMessage[] = [
    {
      role: "system",
      content:
        "Extract 0..N reusable lessons from this session. Reply as JSON: " +
        '{"learnings":[{"name":"short-id","description":"one-line","body":"markdown body"}]}',
    },
    { role: "user", content: transcript },
  ];

  let response: Response;
  try {
    response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.sessionEnd.extractionModel,
        messages: chat,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
  } catch (err) {
    logger?.warn(`memex-hermes[session-end]: extraction request failed: ${errMsg(err)}`);
    return [];
  }

  if (!response.ok) {
    logger?.warn(`memex-hermes[session-end]: extraction HTTP ${response.status}; skipping`);
    return [];
  }

  let parsed: ChatCompletionResponse;
  try {
    parsed = (await response.json()) as ChatCompletionResponse;
  } catch (err) {
    logger?.warn(`memex-hermes[session-end]: JSON parse failed: ${errMsg(err)}`);
    return [];
  }

  const raw = parsed.choices?.[0]?.message?.content ?? "";
  if (!raw) return [];

  try {
    const obj = JSON.parse(raw) as { learnings?: unknown };
    if (!Array.isArray(obj.learnings)) return [];
    const out: ExtractedLearning[] = [];
    for (const item of obj.learnings) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === "string" ? rec.name : "";
      const description = typeof rec.description === "string" ? rec.description : "";
      const body = typeof rec.body === "string" ? rec.body : "";
      if (name.length > 0 && body.length > 0) {
        out.push({ name, description, body });
      }
    }
    return out;
  } catch (err) {
    logger?.warn(`memex-hermes[session-end]: learnings JSON parse failed: ${errMsg(err)}`);
    return [];
  }
}

// Exported for unit testing: the YAML-frontmatter formatting is the security-
// relevant seam (LLM-provided name/description must not corrupt the file).
export function formatLearningFile(learning: ExtractedLearning): string {
  // name/description are LLM-provided — a colon, quote, or newline would corrupt
  // the YAML frontmatter, so emit them as escaped double-quoted scalars.
  return [
    "---",
    `name: ${safeYamlScalar(learning.name)}`,
    `description: ${safeYamlScalar(learning.description)}`,
    "type: session-learning",
    "---",
    "",
    learning.body,
    "",
  ].join("\n");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 30_000 });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
