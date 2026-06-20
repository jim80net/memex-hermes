// Path-traversal hardening for Hermes.tool-remember (cubic P1).
//
// `projectName` is LLM/user-controlled and becomes a path segment under the
// sync repo. A crafted value containing `..` or a separator must be rejected,
// and no scope branch may ever resolve a write target outside the sync repo.

import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { handleToolRemember } from "../../src/hooks/tool-remember.ts";
import { resetState, seedFromEnvelope } from "../../src/state.ts";
import { makeFakePaths, makeTmpRoot } from "./_helpers.ts";

describe("tool-remember path-traversal hardening", () => {
  it("rejects a projectName with a .. traversal segment", async () => {
    const paths = makeFakePaths(await makeTmpRoot());
    await expect(
      handleToolRemember({ content: "x", projectName: "../../../etc" }, "", DEFAULT_CONFIG, paths),
    ).rejects.toThrow(/invalid projectName/);
  });

  it("rejects a projectName containing a path separator", async () => {
    const paths = makeFakePaths(await makeTmpRoot());
    await expect(
      handleToolRemember({ content: "x", projectName: "a/b" }, "", DEFAULT_CONFIG, paths),
    ).rejects.toThrow(/invalid projectName/);
  });

  it("rejects a projectName starting with ~", async () => {
    const paths = makeFakePaths(await makeTmpRoot());
    await expect(
      handleToolRemember({ content: "x", projectName: "~root" }, "", DEFAULT_CONFIG, paths),
    ).rejects.toThrow(/invalid projectName/);
  });

  it("writes a valid named project under the sync repo", async () => {
    const paths = makeFakePaths(await makeTmpRoot());
    const res = await handleToolRemember(
      { content: "# title\nbody", projectName: "my-project" },
      "",
      DEFAULT_CONFIG,
      paths,
    );
    const expectedPrefix = join(paths.syncRepoDir, "projects", "my-project", "memory");
    expect(res.written.startsWith(expectedPrefix)).toBe(true);
  });

  it("backstop rejects a traversal via a crafted session id (session scope)", async () => {
    // session scope derives the project id from state.sessionId, which is NOT
    // run through validateProjectName — the resolved-containment backstop is the
    // line of defense for this vector.
    const paths = makeFakePaths(await makeTmpRoot());
    resetState();
    seedFromEnvelope({ sessionId: "../../../../tmp/evil" });
    try {
      await expect(
        handleToolRemember({ content: "x", scope: "session" }, "", DEFAULT_CONFIG, paths),
      ).rejects.toThrow(/outside the sync repo/);
    } finally {
      resetState();
    }
  });

  it("backstop rejects a symlink that escapes the sync repo", async () => {
    // A projectName is a single segment (no separators), but it could name a
    // pre-existing symlink under projects/ that points outside the repo. The
    // realpath containment check must catch that even though the lexical check
    // cannot.
    const paths = makeFakePaths(await makeTmpRoot());
    const outside = await makeTmpRoot("hermes-outside-");
    await mkdir(join(paths.syncRepoDir, "projects"), { recursive: true });
    await symlink(outside, join(paths.syncRepoDir, "projects", "escape"));
    await expect(
      handleToolRemember({ content: "x", projectName: "escape" }, "", DEFAULT_CONFIG, paths),
    ).rejects.toThrow(/symlink outside the sync repo/);
  });
});
