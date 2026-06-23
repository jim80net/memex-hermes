// Cross-adapter byte-compat conformance (issue #4) — Tier 1.
//
// The load-bearing memory-portability invariant: a memory entry memex-hermes
// writes is read back, unchanged, by the shared @jim80net/memex-core parser that
// every adapter uses. The guarantee is SEMANTIC round-trip of the parsed entry
// (name/description/queries/body), not byte-identity of the file (hermes
// filenames carry a random suffix and are never byte-equal across writers).
//
// memex-claude has no frontmatter-synthesizing writer of its own — its memories
// are authored as .md files and read through this same shared parser — so the
// cross-adapter invariant reduces to "hermes writes → the shared parser reads
// correctly," which is exactly what this file proves, against committed golden
// fixtures (the self-contained peer-adapter stand-in; no live memex-claude).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, parseMemoryFile } from "@jim80net/memex-core";
import { describe, expect, it } from "vitest";
import { formatMemoryEntry } from "../../src/core/memory-format.ts";

const FIXTURE_DIR = "../fixtures/cross-adapter/";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(FIXTURE_DIR + name, import.meta.url)), "utf-8");
}

// The exact input that generated golden-memory-frontmatter.md. The WRITE test
// re-derives the golden from this; the golden is the committed regression
// snapshot + the cross-adapter contract artifact.
const FRONTMATTER_INPUT = {
  name: "standard-dev-flow",
  description: "ship via the standard flow: brainstorm, design, review — café ✓",
  type: "memory" as const,
  body: [
    "When shipping a memex change, follow the standard development flow:",
    "brainstorm 2-3 approaches, write a design, run the review trio, implement",
    "via TDD, then open a PR. Do not skip the review gates.",
  ].join("\n"),
};

describe("cross-adapter memory-file conformance (#4)", () => {
  describe("frontmatter golden (L1a — memex_remember / session-learning shape)", () => {
    const golden = readFixture("golden-memory-frontmatter.md");

    it("reads back to the expected entry via parseMemoryFile (scan/index path)", () => {
      // parseMemoryFile takes a filePath and returns an ARRAY; an individual
      // memory file yields exactly one entry.
      const entries = parseMemoryFile(golden, "golden-memory-frontmatter.md");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        name: "standard-dev-flow",
        description: "ship via the standard flow: brainstorm, design, review — café ✓",
        // hermes-written files carry no `queries:` key → always [].
        queries: [],
        body: FRONTMATTER_INPUT.body,
      });
    });

    it("reads back via parseFrontmatter (the recall read path hermes actually calls)", () => {
      // tool-recall.ts:60 reads via parseFrontmatter, not parseMemoryFile —
      // assert the function hermes uses on its hot read path agrees.
      const { meta, body } = parseFrontmatter(golden);
      expect(meta.name).toBe("standard-dev-flow");
      expect(meta.description).toBe(
        "ship via the standard flow: brainstorm, design, review — café ✓",
      );
      expect(meta.type).toBe("memory");
      expect(body.trim()).toBe(FRONTMATTER_INPUT.body);
    });

    it("the writer reproduces the golden bytes exactly (regression snapshot)", () => {
      expect(formatMemoryEntry(FRONTMATTER_INPUT)).toBe(golden);
    });

    it("round-trips: write → parseMemoryFile → same entry", () => {
      const written = formatMemoryEntry(FRONTMATTER_INPUT);
      const entries = parseMemoryFile(written, "x.md");
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe(FRONTMATTER_INPUT.name);
      expect(entries[0].description).toBe(FRONTMATTER_INPUT.description);
      expect(entries[0].body).toBe(FRONTMATTER_INPUT.body);
    });

    it("is LF-only, BOM-free, with exactly one trailing newline", () => {
      expect(golden.includes("\r")).toBe(false);
      expect(golden.charCodeAt(0)).not.toBe(0xfeff); // no UTF-8 BOM
      expect(golden.endsWith("\n")).toBe(true);
      expect(golden.endsWith("\n\n")).toBe(false);
    });

    it("an embedded colon / unicode / trailing space in description round-trips", () => {
      // These are the adversarial cases that MUST survive — the golden's
      // description carries a `:`, an em-dash, and a non-ASCII glyph. trailing
      // space is collapsed by safeYamlScalar (single-line scalar contract).
      const out = formatMemoryEntry({
        name: "edge",
        description: "k: v — ✓ trailing   ",
        type: "memory",
        body: "b",
      });
      const entry = parseMemoryFile(out, "x.md")[0];
      expect(entry.description).toBe("k: v — ✓ trailing");
    });
  });

  describe("section golden (L1b — mirrored USER.md shape, ## heading + Triggers:)", () => {
    // Synthetic now; to be validated against the operator's real
    // ~/.hermes/memories/USER.md when openclaude-migration delivers it.
    const golden = readFixture("golden-memory-section.md");

    it("parses every ## section with its Triggers as queries", () => {
      const entries = parseMemoryFile(golden, "golden-memory-section.md");
      expect(entries).toHaveLength(2);
      expect(entries[0].name).toBe("Coding standard");
      expect(entries[0].queries).toEqual([
        "what are the coding standards",
        "how should I approach a change",
      ]);
      expect(entries[0].description).toBe(
        "Always do complete, correct work — never cut corners. " +
          "Verify by reading the code, running the tests, and tracing the runtime path.",
      );
      expect(entries[1].name).toBe("Commit discipline");
      expect(entries[1].queries).toEqual(["when do I commit", "commit message style"]);
    });

    it("is LF-only, BOM-free", () => {
      expect(golden.includes("\r")).toBe(false);
      expect(golden.charCodeAt(0)).not.toBe(0xfeff);
    });
  });

  describe("pinned escaping boundary (#10 — embedded quote/backslash)", () => {
    // KNOWN LIMITATION, pinned (not hidden): safeYamlScalar emits YAML
    // double-quoted escapes (\" \\) but parseFrontmatter only strips the outer
    // quotes and never decodes escapes — so an embedded " or \ in a frontmatter
    // SCALAR (name/description) does NOT round-trip. The BODY is unaffected.
    // Tracked in jim80net/memex-hermes#10. When #10 is fixed, flip these to
    // assert fidelity (`toBe(input)`).
    it("embedded double-quote in description does NOT round-trip (current behavior)", () => {
      const input = 'the "standard" flow';
      const out = formatMemoryEntry({ name: "q", description: input, type: "memory", body: "b" });
      const entry = parseMemoryFile(out, "x.md")[0];
      expect(entry.description).not.toBe(input);
      expect(entry.description).toBe('the \\"standard\\" flow'); // backslash artifact
    });

    it("embedded backslash in description does NOT round-trip (current behavior)", () => {
      const input = "path C:\\temp\\x";
      const out = formatMemoryEntry({ name: "b", description: input, type: "memory", body: "b" });
      const entry = parseMemoryFile(out, "x.md")[0];
      expect(entry.description).not.toBe(input);
      expect(entry.description).toBe("path C:\\\\temp\\\\x"); // doubled backslashes
    });

    it("the body round-trips even when it contains quotes/backslashes", () => {
      // Only frontmatter SCALARS hit the boundary; the body is written verbatim.
      const body = 'a "quoted" path C:\\temp and a colon: here';
      const out = formatMemoryEntry({ name: "x", description: "d", type: "memory", body });
      const entry = parseMemoryFile(out, "x.md")[0];
      expect(entry.body).toBe(body);
    });
  });
});
