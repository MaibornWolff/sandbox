import { describe, expect, test } from "bun:test";
import { defineCategory } from "./category-definition.js";
import { generateDockerfile } from "./dockerfile-generation.js";
import {
  addDockerfileLines,
  installAptPackages,
  installCargoPackages,
  installGoPackages,
  installMiseTools,
  installNpmPackages,
  runImageSetupCommands,
} from "./image-setup.js";
import type { ToolDefinition } from "./tool-definition.js";
import { TOOL_REGISTRY } from "./tool-registry.js";
import { resolveTools } from "./tool-resolution.js";

const TEST_CATEGORY = defineCategory({
  id: "generation-test",
  name: "Generation test",
  section: "tools",
  description: "Image generation tests",
});

function tool(
  id: string,
  imageSetup: NonNullable<ToolDefinition["imageSetup"]>,
): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    category: TEST_CATEGORY,
    imageSetup,
  };
}

function position(content: string, value: string): number {
  const result = content.indexOf(value);
  expect(result).toBeGreaterThanOrEqual(0);
  return result;
}

describe("phased Dockerfile generation", () => {
  test("runs all root actions before one ownership barrier and all user actions after it", () => {
    const result = generateDockerfile({
      tools: [
        tool("mixed", {
          asRoot: [
            installAptPackages(["first-root"]),
            runImageSetupCommands(["second-root"], {
              chownToContainerUser: ["/opt/first", "/var/lib/second"],
            }),
          ],
          asContainerUser: [
            installMiseTools(["first-user@lts"]),
            installNpmPackages(["second-user@5.9.2"]),
          ],
        }),
      ],
      baseImage: "sandbox-base:latest",
    });

    const firstRoot = position(result, "first-root");
    const secondRoot = position(result, "second-root");
    const ownership = position(
      result,
      "RUN chown -R sandbox:sandbox /opt/first /var/lib/second",
    );
    const userSwitch = position(result, "USER sandbox");
    const firstUser = position(result, "first-user@lts");
    const secondUser = position(result, "second-user@5.9.2");

    expect(firstRoot).toBeLessThan(secondRoot);
    expect(secondRoot).toBeLessThan(ownership);
    expect(ownership).toBeLessThan(userSwitch);
    expect(userSwitch).toBeLessThan(firstUser);
    expect(firstUser).toBeLessThan(secondUser);
    expect(result.match(/chown -R sandbox:sandbox/g)).toHaveLength(1);

    const runtimeBoundary = position(
      result,
      "# Runtime entrypoint starts as root",
    );
    const userPhase = result.slice(userSwitch, runtimeBoundary);
    expect(userPhase).not.toContain("USER root");
    expect(userPhase).not.toContain("first-root");
    expect(userPhase).not.toContain("second-root");
  });

  test("keeps tool and action declaration order inside each phase", () => {
    const result = generateDockerfile({
      tools: [
        tool("first", {
          asRoot: [runImageSetupCommands(["root-one"])],
          asContainerUser: [runImageSetupCommands(["user-one"])],
        }),
        tool("second", {
          asRoot: [runImageSetupCommands(["root-two"])],
          asContainerUser: [runImageSetupCommands(["user-two"])],
        }),
      ],
      baseImage: "sandbox-base:latest",
    });

    expect(position(result, "root-one")).toBeLessThan(
      position(result, "root-two"),
    );
    expect(position(result, "user-one")).toBeLessThan(
      position(result, "user-two"),
    );
  });

  test("bundles package-manager actions across capabilities", () => {
    const result = generateDockerfile({
      tools: [
        tool("first", {
          asRoot: [installAptPackages(["curl"])],
          asContainerUser: [
            installMiseTools(["node@lts"]),
            installNpmPackages(["first@1"]),
          ],
        }),
        tool("second", {
          asRoot: [installAptPackages(["git"])],
          asContainerUser: [
            runImageSetupCommands(["between-actions"]),
            installMiseTools(["python@3.13"]),
            installNpmPackages(["second@2"]),
          ],
        }),
      ],
      baseImage: "sandbox-base:latest",
    });

    expect(result.match(/apt-get update/g)).toHaveLength(1);
    expect(result.match(/mise use -g/g)).toHaveLength(1);
    expect(result).toContain(
      "RUN --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN mise use -g",
    );
    expect(result.match(/RUN npm install -g/g)).toHaveLength(1);
    expect(result).toContain("curl git");
    expect(result).toContain("node@lts");
    expect(result).toContain("python@3.13");
    expect(result).toContain("first@1");
    expect(result).toContain("second@2");
  });

  test("passes native package and version strings through unchanged", () => {
    const result = generateDockerfile({
      tools: [
        tool("native-versions", {
          asRoot: [installAptPackages(["git=1:2.46.0-1"])],
          asContainerUser: [
            installNpmPackages(["@scope/tool@5.9.2"]),
            installMiseTools(["python@3.13.7"]),
            installGoPackages(["github.com/example/tool@v1.2.3"]),
            installCargoPackages(["ripgrep@14.1.1"]),
          ],
        }),
      ],
      baseImage: "sandbox-base:latest",
    });

    expect(result).toContain("git=1:2.46.0-1");
    expect(result).toContain("npm install -g @scope/tool@5.9.2");
    expect(result).toContain("mise use -g python@3.13.7");
    expect(result).toContain("go install github.com/example/tool@v1.2.3");
    expect(result).toContain("cargo install ripgrep@14.1.1");
  });

  test("rejects a relative image-build ownership path with a specific error", () => {
    expect(() =>
      generateDockerfile({
        tools: [
          tool("invalid", {
            asRoot: [
              addDockerfileLines(["RUN setup"], {
                chownToContainerUser: ["relative/cache"],
              }),
            ],
          }),
        ],
        baseImage: "sandbox-base:latest",
      }),
    ).toThrow(
      "Image setup owned path must be an absolute container path: relative/cache",
    );
  });

  test("deduplicates image-build ownership without reading runtime persistence", () => {
    const result = generateDockerfile({
      tools: [
        {
          ...tool("ownership", {
            asRoot: [
              runImageSetupCommands(["setup"], {
                chownToContainerUser: ["/opt/tool", "/opt/tool"],
              }),
            ],
          }),
          persistPaths: [
            { path: "/runtime/data", use_named_volume: "runtime-data" },
          ],
        },
      ],
      baseImage: "sandbox-base:latest",
    });

    expect(result).toContain("chown -R sandbox:sandbox /opt/tool");
    expect(result).not.toContain("/runtime/data");
  });
});

describe("catalog Dockerfile behavior", () => {
  test("includes explanatory comments around generated tool setup", () => {
    const node = TOOL_REGISTRY.find((tool) => tool.id === "node");
    expect(node).toBeDefined();

    const result = generateDockerfile({
      tools: node ? [node] : [],
      baseImage: "sandbox-base:latest",
    });

    expect(result).toContain("# Languages and tools");
    expect(result).toContain(
      "# GITHUB_TOKEN is available as an optional build secret for API rate limits",
    );
    expect(result).toContain(
      "# https://github.com/settings/tokens (no scopes needed for public repos)",
    );
  });

  test("restores Devbox installer path ownership after all root setup", () => {
    const devbox = TOOL_REGISTRY.find((tool) => tool.id === "devbox");
    expect(devbox).toBeDefined();

    const result = generateDockerfile({
      tools: devbox ? [devbox] : [],
      baseImage: "sandbox-base:latest",
    });

    const nixInstaller = position(result, "install.determinate.systems/nix");
    const devboxInstaller = position(result, "get.jetify.com/devbox");
    const directoryCreation = position(
      result,
      "mkdir -p /home/sandbox/.cache /home/sandbox/.local",
    );
    const ownership = position(
      result,
      "RUN chown -R sandbox:sandbox /nix /home/sandbox/.cache /home/sandbox/.local",
    );

    expect(nixInstaller).toBeLessThan(devboxInstaller);
    expect(devboxInstaller).toBeLessThan(directoryCreation);
    expect(directoryCreation).toBeLessThan(ownership);
  });

  test("stores an empty direct selection", () => {
    const result = generateDockerfile({
      tools: [],
      baseImage: "sandbox-base:latest",
      toolIds: [],
    });

    expect(result).toContain("# Tools: \n");
  });

  test("stores direct selections while installing automatic dependencies", () => {
    const resolved = resolveTools(["agent-browser"]);
    const result = generateDockerfile({
      tools: resolved.dependencyClosure,
      baseImage: "sandbox-base:latest",
      toolIds: resolved.directSelections.map((entry) => entry.id),
    });

    expect(result).toContain("# Tools: agent-browser");
    expect(result).not.toContain("# Tools: agent-browser,node");
    expect(result).toContain("mise use -g node@lts");
    expect(result).toContain("chromium fonts-liberation");
  });

  test("retains generated setup for every migrated capability", () => {
    const result = generateDockerfile({
      tools: TOOL_REGISTRY,
      baseImage: "sandbox-base:latest",
    });

    for (const expected of [
      "node@lts",
      "python@3.13",
      "java@25",
      "go@latest",
      "rust@stable",
      "dotnet@9",
      "php8.5-cli",
      "@ast-grep/cli@latest",
      "terraform@latest",
      "chromium fonts-liberation",
      "@earendil-works/pi-coding-agent@latest",
      "COPY .mise.tom[l]",
      "mise trust --all -y",
      "RUN printf '%s\\n'",
      'ENV PATH="/home/sandbox/go/bin:$PATH"',
    ]) {
      expect(result).toContain(expected);
    }

    const userPhase = result.slice(
      position(result, "USER sandbox"),
      position(result, "# Runtime entrypoint starts as root"),
    );
    expect(userPhase).not.toContain("USER root");
    expect(result.match(/chown -R sandbox:sandbox/g)).toHaveLength(1);
  });

  test("restores the root runtime user after container-user setup", () => {
    const miseEnvironment = TOOL_REGISTRY.find(
      (tool) => tool.id === "mise-env",
    );
    expect(miseEnvironment).toBeDefined();

    const result = generateDockerfile({
      tools: miseEnvironment ? [miseEnvironment] : [],
      baseImage: "sandbox-base:latest",
      includeComments: false,
    });

    expect(result).toEndWith(
      "# Runtime entrypoint starts as root and drops privileges for sessions\nUSER root\n",
    );
    expect(result.indexOf("mise install -y")).toBeLessThan(
      result.lastIndexOf("USER root"),
    );
  });

  test("generates an empty image layer with the required runtime user", () => {
    const result = generateDockerfile({
      tools: [],
      baseImage: "sandbox-base:latest",
      includeComments: false,
    });

    expect(result).toBe(
      "FROM sandbox-base:latest\n\nUSER sandbox\n\n# Runtime entrypoint starts as root and drops privileges for sessions\nUSER root\n",
    );
  });
});
