import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { injectAllowedDomains as injectNetworkDomains } from "#modules/configuration/index.js";
import { createGitFixture } from "#platform/git/__test__/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createMinimalBypassConfig } from "../agent-config-bypass.js";
import { getAgentConfigDefs } from "../agent-config-catalog.js";
import {
  CONFIG_TOML_TEMPLATE,
  PROJECT_CONFIG_TOML_TEMPLATE,
} from "../files/template-loading.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";
import {
  copyBuildContextFiles,
  detectBuildContextFiles,
} from "./build-context-detection.js";

describe("initialization behavior", () => {
  let root: string;

  beforeEach(() => {
    root = createTestDir("initialization");
  });

  afterEach(() => cleanupTestDir(root));

  async function scoped<T>(options: {
    readonly repository?: {
      readonly root: string;
      readonly queriedPath: string;
    };
    readonly operation: () => T | Promise<T>;
  }): Promise<{ readonly result: T; readonly output: string }> {
    const execution = await runInHostTestScope({ root }, ({ processes }) => {
      const git = createGitFixture(processes);
      if (options.repository) git.givenRepository(options.repository);
      else git.givenNoRepository(root);
      git.prepare();
      return options.operation();
    });
    return { result: execution.result, output: execution.stdout };
  }

  it("injects declared network domains without adding a Nix persist mount", () => {
    const domains =
      TOOL_REGISTRY.find((tool) => tool.id === "devbox")?.allowNetwork ?? [];
    const user = injectNetworkDomains(CONFIG_TOML_TEMPLATE, domains);
    const project = injectNetworkDomains(PROJECT_CONFIG_TOML_TEMPLATE, domains);
    expect(user).toContain('"cache.nixos.org"');
    expect(project).toMatch(/^allow_network\s*=\s*\[/m);
    expect(user).not.toContain('path = "/nix"');
    expect(project).not.toContain('path = "/nix"');
    expect(user.match(/^allow_network\s*=\s*\[/gm)).toHaveLength(1);
  });

  it("creates minimal bypass files on the real filesystem", () => {
    const settingsDirectory = path.join(root, "settings");
    for (const definition of getAgentConfigDefs()) {
      if (definition.addBypassSettings && definition.settingsFile) {
        createMinimalBypassConfig(definition, settingsDirectory);
      }
    }
    const claude = JSON.parse(
      fs.readFileSync(
        path.join(settingsDirectory, ".claude", "settings.json"),
        "utf8",
      ),
    );
    expect(claude.permissions.defaultMode).toBe("bypassPermissions");
    expect(
      fs.readFileSync(
        path.join(settingsDirectory, ".codex", "config.toml"),
        "utf8",
      ),
    ).toContain('sandbox_mode = "danger-full-access"');
  });

  it("detects literal and glob build context entries", async () => {
    fs.writeFileSync(path.join(root, "devbox.json"), "{}");
    fs.writeFileSync(path.join(root, "devbox.lock"), "{}");
    const tools = [
      {
        id: "devbox",
        buildContextFiles: [{ pattern: "devbox.*", destination: "" }],
      },
    ] as Parameters<typeof detectBuildContextFiles>[0];
    const { result } = await scoped({
      operation: () => detectBuildContextFiles(tools, root),
    });
    expect(result).toHaveLength(2);
  });

  it("falls back to repository state for literal and glob entries", async () => {
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, "devbox.json"), "{}");
    fs.writeFileSync(path.join(root, "devbox.lock"), "{}");
    const tool = {
      id: "devbox",
      buildContextFiles: [{ pattern: "devbox.*", destination: "" }],
    } as Parameters<typeof detectBuildContextFiles>[0][number];
    const { result } = await scoped({
      repository: { root, queriedPath: nested },
      operation: () => detectBuildContextFiles([tool], nested),
    });
    expect(
      result.map((entry) => path.basename(entry.sourcePath)).sort(),
    ).toEqual(["devbox.json", "devbox.lock"]);
  });

  it("copies declared files and directories and reports failures", async () => {
    const sourceFile = path.join(root, "devbox.json");
    const sourceDirectory = path.join(root, "source-dir");
    fs.writeFileSync(sourceFile, "{}");
    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, "nested.txt"), "nested");

    const { output } = await scoped({
      operation: () =>
        copyBuildContextFiles(
          [
            {
              toolId: "file",
              sourcePath: sourceFile,
              destination: "subdir/devbox.json",
            },
            {
              toolId: "dir",
              sourcePath: sourceDirectory,
              destination: "source-dir",
            },
            {
              toolId: "missing",
              sourcePath: path.join(root, "missing"),
              destination: "missing",
            },
          ],
          root,
        ),
    });

    const dockerRoot = path.join(root, ".sandbox", "docker");
    expect(
      fs.readFileSync(path.join(dockerRoot, "subdir", "devbox.json"), "utf8"),
    ).toBe("{}");
    expect(
      fs.readFileSync(
        path.join(dockerRoot, "source-dir", "nested.txt"),
        "utf8",
      ),
    ).toBe("nested");
    expect(output).toContain("Failed to copy missing");
  });
});
