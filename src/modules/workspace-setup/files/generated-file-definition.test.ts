import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { TOOL_REGISTRY } from "../tools/tool-registry.js";
import type { FileDefinition } from "./generated-file-definition.js";
import {
  detectExistingTools,
  getDockerfilePath,
  getProjectFileDefinitions,
  getUserFileDefinitions,
  hasExistingConfig,
} from "./generated-file-definition.js";

describe("file-definitions", () => {
  describe("getUserFileDefinitions", () => {
    it("returns two definitions (config and dockerfile)", () => {
      const defs = getUserFileDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map((d) => d.id)).toEqual(["config", "dockerfile"]);
    });

    it("dockerfile definition generates valid Dockerfile with FROM", () => {
      const defs = getUserFileDefinitions();
      const dockerDef = defs[1];
      expect(dockerDef?.id).toBe("dockerfile");
      const content = dockerDef?.getTemplate(["node"]) ?? "";
      expect(content).toContain("FROM sandbox-base:latest");
      expect(content).toContain("# Tools:");
    });

    it("dockerfile definition uses defaults when toolIds is empty", () => {
      const defs = getUserFileDefinitions();
      const dockerDef = defs[1];
      const content = dockerDef?.getTemplate([]) ?? "";
      expect(content).toContain("FROM sandbox-base:latest");
    });

    it("adds only the selected agent-specific network domains", () => {
      const configDef = getUserFileDefinitions()[0];
      const cases = [
        {
          toolId: "claude",
          included: ["*.claude.com", "claude.ai"],
          excluded: [
            "api.business.githubcopilot.com",
            "opencode.ai",
            "models.dev",
          ],
        },
        {
          toolId: "copilot",
          included: ["api.business.githubcopilot.com"],
          excluded: ["*.claude.com", "claude.ai", "opencode.ai", "models.dev"],
        },
        {
          toolId: "opencode",
          included: ["opencode.ai", "models.dev"],
          excluded: [
            "*.claude.com",
            "claude.ai",
            "api.business.githubcopilot.com",
          ],
        },
      ];

      for (const testCase of cases) {
        const content = configDef?.getTemplate([testCase.toolId]);
        const config = parseToml(content ?? "") as { allow_network: string[] };
        expect(config.allow_network).toEqual(
          expect.arrayContaining(testCase.included),
        );
        for (const domain of testCase.excluded) {
          expect(config.allow_network).not.toContain(domain);
        }
      }
    });

    it("paths point to the scoped sandbox config dir", () => {
      const configRoot = "/test/scoped-sandbox-config";
      const paths = runWithTestLogger(
        () =>
          getUserFileDefinitions().map((definition) => definition.getPath()),
        { variables: { SANDBOX_CONFIG_DIR: configRoot } },
      );

      expect(paths).toEqual([
        path.join(configRoot, "config.toml"),
        path.join(configRoot, "docker", "Dockerfile"),
      ]);
    });
  });

  describe("getDockerfilePath", () => {
    it("returns path when dockerfile definition is present", () => {
      const defs: FileDefinition[] = [
        {
          id: "config",
          name: "config.toml",
          getPath: () => "/tmp/config.toml",
          getTemplate: () => "",
        },
        {
          id: "dockerfile",
          name: "Dockerfile",
          getPath: () => "/tmp/docker/Dockerfile",
          getTemplate: () => "",
        },
      ];
      expect(getDockerfilePath(defs)).toBe("/tmp/docker/Dockerfile");
    });

    it("returns null when no dockerfile definition exists", () => {
      const defs: FileDefinition[] = [
        {
          id: "config",
          name: "config.toml",
          getPath: () => "/tmp/config.toml",
          getTemplate: () => "",
        },
      ];
      expect(getDockerfilePath(defs)).toBeNull();
    });
  });

  describe("hasExistingConfig", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestDir("file-defs-config");
    });

    afterEach(() => {
      cleanupTestDir(testDir);
    });

    it("returns false when no files exist", () => {
      const defs: FileDefinition[] = [
        {
          id: "config",
          name: "config.toml",
          getPath: () => path.join(testDir, "nonexistent.toml"),
          getTemplate: () => "",
        },
      ];
      expect(hasExistingConfig(defs)).toBe(false);
    });

    it("returns true when any file exists", () => {
      const filePath = path.join(testDir, "config.toml");
      fs.writeFileSync(filePath, "test");
      const defs: FileDefinition[] = [
        {
          id: "config",
          name: "config.toml",
          getPath: () => filePath,
          getTemplate: () => "",
        },
        {
          id: "dockerfile",
          name: "Dockerfile",
          getPath: () => path.join(testDir, "nonexistent"),
          getTemplate: () => "",
        },
      ];
      expect(hasExistingConfig(defs)).toBe(true);
    });
  });

  describe("detectExistingTools", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestDir("file-defs-detect");
    });

    afterEach(() => {
      cleanupTestDir(testDir);
    });

    function makeDefs(dockerfilePath: string): FileDefinition[] {
      return [
        {
          id: "config",
          name: "config.toml",
          getPath: () => path.join(testDir, "config.toml"),
          getTemplate: () => "",
        },
        {
          id: "dockerfile",
          name: "Dockerfile",
          getPath: () => dockerfilePath,
          getTemplate: () => "",
        },
      ];
    }

    it("returns hasDockerfile: false when no Dockerfile exists", () => {
      const defs = makeDefs(path.join(testDir, "nonexistent"));
      const result = detectExistingTools(defs);
      expect(result).toEqual({
        toolIds: [],
        unknown: [],
        hasDockerfile: false,
        hasToolComment: false,
      });
    });

    it("returns hasDockerfile: true, hasToolComment: false when Dockerfile has no comment", () => {
      const dockerfilePath = path.join(testDir, "Dockerfile");
      fs.writeFileSync(dockerfilePath, "FROM base:latest\nRUN echo hello");
      const defs = makeDefs(dockerfilePath);
      const result = detectExistingTools(defs);
      expect(result.hasDockerfile).toBe(true);
      expect(result.hasToolComment).toBe(false);
      expect(result.toolIds).toEqual([]);
    });

    it("returns validated toolIds and unknown IDs when comment exists", () => {
      const dockerfilePath = path.join(testDir, "Dockerfile");
      const validTool = TOOL_REGISTRY[0];
      if (!validTool) throw new Error("No tools in registry");
      fs.writeFileSync(
        dockerfilePath,
        `# Tools: ${validTool.id},fake-tool\nFROM base:latest`,
      );
      const defs = makeDefs(dockerfilePath);
      const result = detectExistingTools(defs);
      expect(result.hasDockerfile).toBe(true);
      expect(result.hasToolComment).toBe(true);
      expect(result.toolIds).toContain(validTool.id);
      expect(result.unknown).toEqual(["fake-tool"]);
    });

    it("returns empty toolIds for Tools comment with only unknown IDs", () => {
      const dockerfilePath = path.join(testDir, "Dockerfile");
      fs.writeFileSync(
        dockerfilePath,
        "# Tools: totally-fake,also-fake\nFROM base:latest",
      );
      const defs = makeDefs(dockerfilePath);
      const result = detectExistingTools(defs);
      expect(result.toolIds).toEqual([]);
      expect(result.unknown).toEqual(["totally-fake", "also-fake"]);
      expect(result.hasToolComment).toBe(true);
    });
  });

  describe("getProjectFileDefinitions", () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestDir("project-file-defs");
    });

    afterEach(() => cleanupTestDir(testDir));

    function scoped<T>(operation: () => T): T {
      return runWithTestLogger(operation, {
        currentWorkingDirectory: testDir,
        homeDirectory: path.join(testDir, "home"),
        variables: {
          SANDBOX_CONFIG_DIR: path.join(testDir, "sandbox-config"),
        },
      });
    }

    it("returns two definitions", () => {
      const ids = scoped(() =>
        getProjectFileDefinitions().map((def) => def.id),
      );
      expect(ids).toEqual(["config", "dockerfile"]);
    });

    it("extends the base image without a user Dockerfile", () => {
      const content = scoped(
        () => getProjectFileDefinitions()[1]?.getTemplate([]) ?? "",
      );
      expect(content).toContain("FROM sandbox-base:latest");
    });

    it("extends the user image when its Dockerfile exists", () => {
      const dockerDirectory = path.join(testDir, "sandbox-config", "docker");
      fs.mkdirSync(dockerDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(dockerDirectory, "Dockerfile"),
        "FROM sandbox-base:latest\n",
      );
      const content = scoped(
        () => getProjectFileDefinitions()[1]?.getTemplate([]) ?? "",
      );
      expect(content).toContain("FROM sandbox-user:latest");
    });

    it("maps paths below the scoped current directory", () => {
      const paths = scoped(() =>
        getProjectFileDefinitions().map((definition) => definition.getPath()),
      );
      expect(paths).toEqual([
        path.join(testDir, ".sandbox", "config.toml"),
        path.join(testDir, ".sandbox", "docker", "Dockerfile"),
      ]);
    });
  });
});
