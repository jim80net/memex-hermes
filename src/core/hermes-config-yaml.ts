import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Logger } from "@jim80net/memex-core";
import { getHermesPaths } from "./hermes-paths.ts";

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Read `$HERMES_HOME/config.yaml`, extract the `external_dirs` entry, expand
 * `~` and `${VAR}` references, and return absolute paths to include in the
 * skill scan list (design §6 / hermes-path-resolution spec).
 *
 * Failure semantics, per the spec:
 *  - Missing file  → return [] silently (no warning).
 *  - Malformed YAML / unreadable → log a warning identifying the problem and
 *    return [] so the scan proceeds with `$HERMES_HOME/skills/` only.
 *
 * This is intentionally a minimal parser rather than a full YAML engine: the
 * only key we consume is `external_dirs`, supported in both flow form
 * (`external_dirs: ["a", "b"]`) and block form (a `-` list on following
 * indented lines). It tolerates the key appearing at the top level or nested
 * under a section.
 */
export function parseExternalDirs(hermesHome?: string, logger?: Logger): string[] {
  const { hermesConfigPath } = getHermesPaths(hermesHome);

  let raw: string;
  try {
    raw = readFileSync(hermesConfigPath, "utf-8");
  } catch (err) {
    if (isNotFound(err)) return [];
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn(
      `memex-hermes: cannot read ${hermesConfigPath}: ${reason}; ignoring external_dirs`,
    );
    return [];
  }

  try {
    const dirs = extractExternalDirs(raw);
    return dirs.map(expandPath).filter((p) => p.length > 0);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger?.warn(
      `memex-hermes: malformed config.yaml at ${hermesConfigPath}: ${reason}; ignoring external_dirs`,
    );
    return [];
  }
}

/**
 * Expand `~` (home) and `${VAR}` / `$VAR` (environment) references in a path
 * and resolve it to an absolute path. Exported for unit testing.
 */
export function expandPath(value: string): string {
  let expanded = value.trim();
  if (expanded.length === 0) return "";

  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => envValue(name));
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => envValue(name));

  if (expanded === "~") {
    expanded = homedir();
  } else if (expanded.startsWith("~/")) {
    expanded = join(homedir(), expanded.slice(2));
  }

  if (!isAbsolute(expanded)) {
    expanded = join(homedir(), expanded);
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function envValue(name: string): string {
  return process.env[name] ?? "";
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * Extract the value list for the `external_dirs` key. Supports both flow
 * (`external_dirs: ["a", "b"]`) and block (`external_dirs:` then indented
 * `- a` lines) styles. Comments and blank lines are skipped. Throws on a flow
 * value that is opened but never closed (a genuine parse error).
 */
function extractExternalDirs(raw: string): string[] {
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    const match = line.match(/^(\s*)external_dirs\s*:\s*(.*)$/);
    if (!match) continue;

    const keyIndent = match[1].length;
    const inlineValue = match[2].trim();

    if (inlineValue.length > 0) {
      return parseFlowList(inlineValue);
    }
    return parseBlockList(lines, i + 1, keyIndent);
  }

  return [];
}

function parseFlowList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) {
    // A bare scalar value: `external_dirs: /one/dir`
    return [unquote(trimmed)];
  }
  if (!trimmed.endsWith("]")) {
    throw new Error("unterminated flow sequence for external_dirs");
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter((item) => item.length > 0);
}

function parseBlockList(lines: string[], start: number, keyIndent: number): string[] {
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const stripped = stripComment(lines[i]);
    if (stripped.trim().length === 0) continue;

    const indent = stripped.length - stripped.trimStart().length;
    if (indent <= keyIndent) break; // dedent ends this block

    const itemMatch = stripped.trim().match(/^-\s*(.*)$/);
    if (!itemMatch) break; // a non-list sibling key ends the block
    out.push(unquote(itemMatch[1].trim()));
  }
  return out;
}

function stripComment(line: string): string {
  // Strip an unquoted trailing comment. A `#` inside quotes is preserved.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
