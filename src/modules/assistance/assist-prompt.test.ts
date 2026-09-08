import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { getPackageRootPath } from "#platform/filesystem/index.js";
import {
  createHostGitFixture,
  runInHostTestScope,
} from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { buildAssistPrompt } from "./assist-prompt.js";

describe("buildAssistPrompt", () => {
  test("uses mounted package knowledge paths inside the sandbox", async () => {
    const root = createTestDir("assist-prompt-inside");
    try {
      const { result: prompt } = await runInHostTestScope(
        { root, variables: { SANDBOX: "1" } },
        () => buildAssistPrompt(),
      );

      expect(prompt).toContain("INSIDE a Sandbox container");
      expect(prompt).toContain("README: /opt/sandbox-cli/README.md");
      expect(prompt).toContain("Docs: /opt/sandbox-cli/docs/");
      expect(prompt).toContain(
        "Tool registry: /opt/sandbox-cli/src/modules/workspace-setup/tools/tool-registry.ts",
      );
    } finally {
      cleanupTestDir(root);
    }
  });

  test("resolves host knowledge and configuration paths from scoped owners", async () => {
    const root = createTestDir("assist-prompt-host");
    try {
      const { result: prompt } = await runInHostTestScope(
        { root },
        ({ processes }) => {
          createHostGitFixture(processes).givenRepository({ root });
          return buildAssistPrompt();
        },
      );
      const packageRoot = getPackageRootPath();

      for (const knowledgePath of [
        path.join(packageRoot, "README.md"),
        `${path.join(packageRoot, "docs")}${path.sep}`,
        `${path.join(packageRoot, "src")}${path.sep}`,
        `${path.join(packageRoot, "docker")}${path.sep}`,
        `${path.join(packageRoot, "templates")}${path.sep}`,
        path.join(
          packageRoot,
          "src",
          "modules",
          "workspace-setup",
          "tools",
          "tool-registry.ts",
        ),
      ]) {
        expect(prompt).toContain(knowledgePath);
      }
      expect(prompt).toContain(path.join(root, ".sandbox", "config.toml"));
      expect(prompt).toContain(path.join(root, "config", "settings"));
    } finally {
      cleanupTestDir(root);
    }
  });
});
