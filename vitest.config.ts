import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/ts/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/.claude/worktrees/**",
      "test/python/**",
      "test/e2e/**",
    ],
  },
});
