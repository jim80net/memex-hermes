import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@jim80net/memex-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandPath, parseExternalDirs } from "../../src/core/hermes-config-yaml.ts";

function captureLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    info: () => {},
    warn: (m) => warnings.push(m),
    error: () => {},
  };
  return { logger, warnings };
}

describe("parseExternalDirs", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hermes-yaml-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    delete process.env.HERMES_TEST_DIR;
  });

  it("missing config.yaml is silent and returns []", () => {
    const { logger, warnings } = captureLogger();
    expect(parseExternalDirs(home, logger)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} literal is the YAML fixture under test
  it("expands ~ and ${VAR} in a flow-style external_dirs list", async () => {
    process.env.HERMES_TEST_DIR = "/srv/from/env";
    await writeFile(
      join(home, "config.yaml"),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${VAR} is literal YAML the parser must expand
      'external_dirs: ["~/.agents/skills", "${HERMES_TEST_DIR}/skills", "/srv/shared/skills"]\n',
    );
    const { logger, warnings } = captureLogger();
    const dirs = parseExternalDirs(home, logger);
    expect(dirs).toEqual([
      join(homedir(), ".agents", "skills"),
      "/srv/from/env/skills",
      "/srv/shared/skills",
    ]);
    expect(warnings).toEqual([]);
  });

  it("parses a block-style external_dirs list nested under a section", async () => {
    await writeFile(
      join(home, "config.yaml"),
      [
        "memory:",
        "  external_dirs:",
        "    - /one/skills",
        "    - ~/two/skills",
        "other: value",
      ].join("\n"),
    );
    const dirs = parseExternalDirs(home);
    expect(dirs).toEqual(["/one/skills", join(homedir(), "two", "skills")]);
  });

  it("ignores inline comments and blank lines", async () => {
    await writeFile(
      join(home, "config.yaml"),
      [
        "# leading comment",
        "external_dirs:",
        "  - /a/skills  # trailing comment",
        "",
        "  - /b/skills",
      ].join("\n"),
    );
    expect(parseExternalDirs(home)).toEqual(["/a/skills", "/b/skills"]);
  });

  it("malformed YAML (unterminated flow list) logs a warning and returns []", async () => {
    await writeFile(join(home, "config.yaml"), 'external_dirs: ["~/skills", "/srv/skills"\n');
    const { logger, warnings } = captureLogger();
    expect(parseExternalDirs(home, logger)).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("malformed config.yaml");
  });

  it("returns [] when external_dirs is absent", async () => {
    await writeFile(join(home, "config.yaml"), "memory:\n  provider: memex\n");
    expect(parseExternalDirs(home)).toEqual([]);
  });
});

describe("expandPath", () => {
  afterEach(() => {
    delete process.env.MEMEX_YAML_TEST;
  });

  it("expands a lone ~ to the home directory", () => {
    expect(expandPath("~")).toBe(homedir());
  });

  it("expands ~/ prefix", () => {
    expect(expandPath("~/foo/bar")).toBe(join(homedir(), "foo", "bar"));
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${VAR} literal is the input the expander must resolve
  it("expands ${VAR} and $VAR", () => {
    process.env.MEMEX_YAML_TEST = "/expanded";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} input under test
    expect(expandPath("${MEMEX_YAML_TEST}/x")).toBe("/expanded/x");
    expect(expandPath("$MEMEX_YAML_TEST/y")).toBe("/expanded/y");
  });

  it("leaves an absolute path unchanged", () => {
    expect(expandPath("/already/absolute")).toBe("/already/absolute");
  });

  it("resolves a relative path against home", () => {
    expect(expandPath("rel/path")).toBe(join(homedir(), "rel", "path"));
  });
});
