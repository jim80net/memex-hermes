// Shared YAML-frontmatter scalar sanitization.
//
// Both Hermes.session-end (learnings) and Hermes.tool-remember (memories) write
// `name:` / `description:` frontmatter from LLM- or user-provided strings. A
// raw colon, quote, or newline in those values produces malformed frontmatter
// (a colon starts a new mapping key; a newline breaks out of the value; an
// unbalanced quote is unparseable). Emitting the value as a properly-escaped
// double-quoted YAML scalar makes any such string safe to round-trip.

/**
 * Render an arbitrary string as a single-line, double-quoted YAML scalar.
 *
 * - Newlines / tabs / carriage returns collapse to spaces (frontmatter values
 *   are single-line by contract here).
 * - Backslashes and double-quotes are escaped per the YAML double-quoted style,
 *   so embedded `"` and `:` survive intact and cannot terminate the value.
 *
 * The result INCLUDES the surrounding quotes, e.g. `safeYamlScalar('a: b')`
 * → `"a: b"`. Callers interpolate it directly after the key: `name: ${...}`.
 */
export function safeYamlScalar(value: string): string {
  const oneLine = value.replace(/[\r\n\t]+/g, " ").trim();
  const escaped = oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
