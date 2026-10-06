import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "#modules/configuration/index.js";
import type { ContainerRuntime } from "#platform/container-runtime/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import {
  cleanupTestDir,
  createTestConfig,
  createTestDir,
} from "#test/utils.js";
import { buildContainerArgs as buildContainerArgsWithoutLogger } from "./container-arguments.js";
import { buildExecArgs as buildExecArgsWithoutScope } from "./session-arguments.js";

type ContainerArgumentRuntime = Pick<
  ContainerRuntime,
  "runtime" | "getHostInternalDns" | "getRuntimeRunFlags"
>;

function createContainerArgumentRuntime(
  overrides: Partial<ContainerArgumentRuntime> = {},
): ContainerArgumentRuntime {
  return {
    runtime: "docker",
    getHostInternalDns: () => "host.docker.internal",
    getRuntimeRunFlags: () => [],
    ...overrides,
  };
}

const defaultConfig = createTestConfig();
const persistenceTestDataDir = createTestDir("container-persistence");
afterAll(() => cleanupTestDir(persistenceTestDataDir));
type BuildContainerArgsOptions = Parameters<
  typeof buildContainerArgsWithoutLogger
>[1];
type TestBuildContainerArgsOptions = Omit<
  BuildContainerArgsOptions,
  "repositoryRoots" | "runtimePackage"
> & {
  readonly repositoryRoots?: BuildContainerArgsOptions["repositoryRoots"];
  readonly service: ContainerArgumentRuntime;
};

const runtimePackage = {
  id: `1.70.0-${"a".repeat(64)}`,
  mount: {
    hostPath: "/test/data/sandbox/runtime/1.70.0-test",
    containerPath: "/opt/sandbox-cli",
    mode: "ro" as const,
  },
  [Symbol.asyncDispose]: () => Promise.resolve(),
};

const noRepositoryRoots = {
  worktreeRoot: null,
  mainRepoRoot: null,
};

function buildContainerArgs(
  options: TestBuildContainerArgsOptions,
): ReturnType<typeof buildContainerArgsWithoutLogger> {
  const { service, repositoryRoots = noRepositoryRoots, ...request } = options;
  return runWithTestLogger(() =>
    buildContainerArgsWithoutLogger(service, {
      ...request,
      repositoryRoots,
      runtimePackage,
    }),
  );
}

const buildExecArgs: typeof buildExecArgsWithoutScope = (...args) =>
  runWithTestLogger(() => buildExecArgsWithoutScope(...args));

function buildContainerArgsWithVariables(
  variables: Readonly<Record<string, string>>,
  options: TestBuildContainerArgsOptions,
): ReturnType<typeof buildContainerArgsWithoutLogger> {
  const { service, repositoryRoots = noRepositoryRoots, ...request } = options;
  return runWithTestLogger(
    () =>
      buildContainerArgsWithoutLogger(service, {
        ...request,
        repositoryRoots,
        runtimePackage,
      }),
    { variables },
  );
}

function getInteractiveShellExecArgs(
  variables: Readonly<Record<string, string>> = {},
): string[] {
  return runWithTestLogger(
    () =>
      buildExecArgsWithoutScope({
        containerName: "sandbox-test-a1b2",
        currentDir: "/test/project",
        command: ["zsh"],
        stdin: true,
        tty: true,
        proxyEnabled: true,
      }),
    { variables },
  );
}

function getInteractiveShellExecArgsWithTerm(term: string): string[] {
  return getInteractiveShellExecArgs({ TERM: term });
}

/**
 * Helper to extract SANDBOX_SETTINGS JSON from buildContainerArgs result
 */
async function getSettingsFromArgs(config: Config): Promise<unknown> {
  const { args } = await buildContainerArgs({
    config,
    projectRoot: "/test/project",
    currentDir: "/test/project",
    projectSlug: "test-project-a1b2",
    service: createContainerArgumentRuntime(),
  });
  const settingsEnv = args.find((arg) => arg.startsWith("SANDBOX_SETTINGS="));
  if (!settingsEnv) {
    throw new Error("SANDBOX_SETTINGS not found in args");
  }
  return JSON.parse(settingsEnv.replace("SANDBOX_SETTINGS=", ""));
}

/**
 * Helper to get full args array from buildContainerArgs.
 * Uses Docker-like runtime flags so tests can assert on sysctl/ulimit/cap-add.
 */
async function getArgsForConfig(config: Config): Promise<string[]> {
  const { args } = await buildContainerArgs({
    config,
    projectRoot: "/test/project",
    currentDir: "/test/project",
    projectSlug: "test-project-a1b2",
    service: createContainerArgumentRuntime({
      getRuntimeRunFlags: (flagConfig) => {
        const flags = [
          "--cap-add=NET_ADMIN",
          "--sysctl=net.ipv4.tcp_tw_reuse=1",
          "--sysctl=net.ipv4.ip_local_port_range=1024\t65535",
          "--sysctl=net.ipv4.tcp_fin_timeout=10",
          "--ulimit",
          "nofile=65536:65536",
        ];
        if (flagConfig?.shmSize) {
          flags.push("--shm-size", flagConfig.shmSize);
        }
        return flags;
      },
    }),
  });
  return args;
}

/**
 * Helper to extract SANDBOX_FIREWALL JSON from buildContainerArgs result
 */
async function getFirewallFromArgs(config: Config): Promise<unknown | null> {
  const args = await getArgsForConfig(config);
  const firewallEnv = args.find((arg) => arg.startsWith("SANDBOX_FIREWALL="));
  if (!firewallEnv) {
    return null;
  }
  return JSON.parse(firewallEnv.replace("SANDBOX_FIREWALL=", ""));
}

describe("buildContainerArgs - settings", () => {
  test("passes empty settings manifest", async () => {
    const settings = await getSettingsFromArgs(defaultConfig);
    expect(settings).toEqual({ mountPaths: [], copyPaths: [] });
  });

  test("separates mount and copy settings in the manifest", async () => {
    const settings = await getSettingsFromArgs({
      ...defaultConfig,
      settings: [
        { path: ".claude/*.json", mode: "mount" },
        { path: ".codex/config.toml", mode: "copy" },
      ],
    });
    expect(settings).toEqual({
      mountPaths: [".claude/*.json"],
      copyPaths: [".codex/config.toml"],
    });
  });

  test("passes mount exclusions correctly", async () => {
    const settings = await getSettingsFromArgs({
      ...defaultConfig,
      settings: [
        { path: "**/*", mode: "mount" },
        { path: "!node_modules", mode: "mount" },
        { path: "!.git", mode: "mount" },
      ],
    });
    expect(settings).toEqual({
      mountPaths: ["**/*", "!node_modules", "!.git"],
      copyPaths: [],
    });
  });

  test("passes complex mount patterns", async () => {
    const settings = await getSettingsFromArgs({
      ...defaultConfig,
      settings: [
        { path: ".claude/*.json", mode: "mount" },
        { path: ".claude/skills/", mode: "mount" },
        { path: "!.claude/projects/**", mode: "mount" },
        { path: ".config/**/*", mode: "mount" },
        { path: "!.config/node_modules", mode: "mount" },
      ],
    });
    expect(settings).toEqual({
      mountPaths: [
        ".claude/*.json",
        ".claude/skills/",
        "!.claude/projects/**",
        ".config/**/*",
        "!.config/node_modules",
      ],
      copyPaths: [],
    });
  });

  test("rejects a read-only custom mount over a copy destination parent", async () => {
    await expect(
      getSettingsFromArgs({
        ...defaultConfig,
        mounts: ["/host/codex:/home/sandbox/.codex:ro"],
        settings: [{ path: ".codex/config.toml", mode: "copy" }],
      }),
    ).rejects.toThrow("read-only mount /home/sandbox/.codex");
  });

  test("rejects a writable custom mount at the copy destination", async () => {
    await expect(
      getSettingsFromArgs({
        ...defaultConfig,
        mounts: ["/host/config.toml:/home/sandbox/.codex/config.toml:rw"],
        settings: [{ path: ".codex/config.toml", mode: "copy" }],
      }),
    ).rejects.toThrow("destination /home/sandbox/.codex/config.toml");
  });

  test("allows a writable custom mount over a copy destination parent", async () => {
    await expect(
      getSettingsFromArgs({
        ...defaultConfig,
        mounts: ["/host/codex:/home/sandbox/.codex:rw"],
        settings: [{ path: ".codex/config.toml", mode: "copy" }],
      }),
    ).resolves.toEqual({
      mountPaths: [],
      copyPaths: [".codex/config.toml"],
    });
  });

  test("handles special characters in mount patterns", async () => {
    const settings = await getSettingsFromArgs({
      ...defaultConfig,
      settings: [
        { path: ".my-agent/**/*.json", mode: "mount" },
        { path: "!.my-agent/node_modules/**", mode: "mount" },
      ],
    });
    expect(settings).toEqual({
      mountPaths: [".my-agent/**/*.json", "!.my-agent/node_modules/**"],
      copyPaths: [],
    });
  });
});

// ---------------------------------------------------------------------------
// buildContainerArgs tests
// ---------------------------------------------------------------------------

describe("buildContainerArgs - basic structure", () => {
  test("does not include run, --rm, or -it", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args).not.toContain("run");
    expect(args).not.toContain("--rm");
    expect(args).not.toContain("-it");
  });

  test("does not include --name", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args).not.toContain("--name");
  });

  test("resolves glob persistence from the project root", async () => {
    const projectRoot = path.join(persistenceTestDataDir, "project");
    const currentDir = path.join(projectRoot, "repos", "app");
    const virtualEnvironment = path.join(currentDir, ".venv");
    fs.mkdirSync(virtualEnvironment, { recursive: true });

    const { args } = await buildContainerArgsWithVariables(
      { XDG_DATA_HOME: persistenceTestDataDir },
      {
        config: {
          ...defaultConfig,
          persistPaths: [
            {
              path: "./**/.venv",
              global: false,
              onlyIfExists: false,
            },
          ],
        },
        projectRoot,
        currentDir,
        projectSlug: "test-project-a1b2",
        service: createContainerArgumentRuntime(),
      },
    );

    expect(args.some((arg) => arg.endsWith(`:${virtualEnvironment}:rw`))).toBe(
      true,
    );
    expect(
      args.some((arg) =>
        arg.endsWith(`:${path.join(currentDir, "repos", "app", ".venv")}:rw`),
      ),
    ).toBe(false);
  });

  test("ends with image name (no CMD)", async () => {
    const { args, imageName } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    const len = args.length;
    // Image should be the last arg (entrypoint handles PID 1 lifecycle)
    expect(args[len - 1]).toMatch(/^sandbox-/);
    expect(imageName).toBe(args[len - 1] as string);
    // Should NOT contain sleep infinity
    expect(args).not.toContain("sleep");
    expect(args).not.toContain("infinity");
  });

  test("returns imageName matching sandbox image pattern", async () => {
    const { imageName } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(imageName).toMatch(/^sandbox-/);
  });

  test("includes project and runtime labels", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args).toContain("sandbox.project=test-project-a1b2");
    expect(args).toContain(`sandbox.runtime=${runtimePackage.id}`);
  });

  test("bind mounts the cached runtime read-only", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args).toContain(
      "/test/data/sandbox/runtime/1.70.0-test:/opt/sandbox-cli:ro",
    );
  });

  test("includes workspace mount", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    const mountIdx = args.findIndex((arg) =>
      arg.includes("/test/project:/test/project:rw"),
    );
    expect(mountIdx).toBeGreaterThanOrEqual(0);
  });

  test("includes SANDBOX=1 env", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args).toContain("SANDBOX=1");
  });

  test("includes cache volume", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args.some((a) => a.includes("sandbox-cache:/var/cache"))).toBe(true);
  });

  test("does not include working directory (-w)", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args).not.toContain("-w");
  });

  test("does not include terminal passthrough vars", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    // TERM is a session concern, should not be in container args
    const hasTermArg = args.some(
      (a) => a.startsWith("TERM=") && !a.startsWith("TERM_"),
    );
    expect(hasTermArg).toBe(false);
  });
});

describe("buildContainerArgs - IDE bridge", () => {
  test("includes CLAUDE_CODE_SSE_PORT as a structural environment pair", async () => {
    const { args } = await buildContainerArgsWithVariables(
      { CLAUDE_CODE_SSE_PORT: "23456" },
      {
        config: defaultConfig,
        projectRoot: "/test/project",
        currentDir: "/test/project",
        projectSlug: "test-project-a1b2",
        service: createContainerArgumentRuntime(),
      },
    );
    const valueIndex = args.indexOf("CLAUDE_CODE_SSE_PORT=23456");
    expect(args[valueIndex - 1]).toBe("-e");
  });

  test("host IDE bridge port overrides a conflicting config value", async () => {
    const { args } = await buildContainerArgsWithVariables(
      { CLAUDE_CODE_SSE_PORT: "23456" },
      {
        config: {
          ...defaultConfig,
          env: ["CLAUDE_CODE_SSE_PORT=12345"],
        },
        projectRoot: "/test/project",
        currentDir: "/test/project",
        projectSlug: "test-project-a1b2",
        service: createContainerArgumentRuntime(),
      },
    );
    const portAssignments = args.filter((arg) =>
      arg.startsWith("CLAUDE_CODE_SSE_PORT="),
    );
    expect(portAssignments.at(-1)).toBe("CLAUDE_CODE_SSE_PORT=23456");
  });

  test("does not include CLAUDE_CODE_SSE_PORT when unset on the host", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    const hasIdePortArg = args.some((a) =>
      a.startsWith("CLAUDE_CODE_SSE_PORT="),
    );
    expect(hasIdePortArg).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildExecArgs tests
// ---------------------------------------------------------------------------

describe("buildExecArgs", () => {
  test("includes -it when interactive", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
    });
    expect(args).toContain("-it");
  });

  test("attaches stdin without tty when non-interactive", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["cat"],
      stdin: true,
      tty: false,
      proxyEnabled: true,
    });
    expect(args).toContain("-i");
    expect(args).not.toContain("-it");
    expect(args).not.toContain("-t");
  });

  test("does not include -i separately when interactive", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
    });
    expect(args).toContain("-it");
    expect(args).not.toContain("-i");
  });

  test("allocates tty without stdin when requested", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: false,
      tty: true,
      proxyEnabled: true,
    });
    expect(args).toContain("-t");
    expect(args).not.toContain("-it");
    expect(args).not.toContain("-i");
  });

  test("includes working directory", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project/src",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
    });
    const wdIdx = args.indexOf("-w");
    expect(wdIdx).toBeGreaterThanOrEqual(0);
    expect(args[wdIdx + 1]).toBe("/test/project/src");
  });

  test("includes container name and exec-entrypoint.sh", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
    });
    expect(args).toContain("sandbox-test-a1b2");
    expect(args).toContain("/usr/local/bin/exec-entrypoint.sh");
  });

  test("includes command after exec-entrypoint.sh", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["echo", "hello", "world"],
      stdin: true,
      tty: false,
      proxyEnabled: true,
    });
    const entrypointIdx = args.indexOf("/usr/local/bin/exec-entrypoint.sh");
    expect(args[entrypointIdx + 1]).toBe("echo");
    expect(args[entrypointIdx + 2]).toBe("hello");
    expect(args[entrypointIdx + 3]).toBe("world");
  });

  test("keeps portable TERM values", () => {
    const args = getInteractiveShellExecArgsWithTerm("tmux-256color");

    expect(args).toEqual(expect.arrayContaining(["TERM=tmux-256color"]));
  });

  test("falls back to xterm-256color for terminal-specific TERM values", () => {
    const args = getInteractiveShellExecArgsWithTerm("xterm-some-new-terminal");

    expect(args).toEqual(expect.arrayContaining(["TERM=xterm-256color"]));
  });

  test("injects host command escape data only into execution sessions", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
      hostCommandEscapeEnvironment: {
        SANDBOX_HOST_COMMAND_ESCAPE_ENDPOINT:
          "ws://host.docker.internal:4321/session",
        SANDBOX_HOST_COMMAND_ESCAPE_PROTOCOL: "sandbox-host-command-escape.v1",
        SANDBOX_HOST_COMMAND_ESCAPE_TOKEN: "secret-token",
      },
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "SANDBOX_HOST_COMMAND_ESCAPE_ENDPOINT=ws://host.docker.internal:4321/session",
        "SANDBOX_HOST_COMMAND_ESCAPE_PROTOCOL=sandbox-host-command-escape.v1",
        "SANDBOX_HOST_COMMAND_ESCAPE_TOKEN=secret-token",
      ]),
    );
  });

  test("includes SANDBOX_DEBUG when verbose", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
      verbose: true,
    });
    expect(args).toContain("SANDBOX_DEBUG=1");
  });

  test("does not include SANDBOX_DEBUG when not verbose", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
    });
    expect(args).not.toContain("SANDBOX_DEBUG=1");
  });

  test("does not include mounts, ports, or SANDBOX=1", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
    });
    expect(args).not.toContain("-v");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("SANDBOX=1");
  });
});

// ---------------------------------------------------------------------------
// buildContainerArgs - firewall and proxy tests
// ---------------------------------------------------------------------------

describe("buildContainerArgs - firewall and proxy", () => {
  test("always includes NET_ADMIN capability", async () => {
    const argsRestricted = await getArgsForConfig({
      ...defaultConfig,
      fullNetwork: false,
    });
    expect(argsRestricted).toContain("--cap-add=NET_ADMIN");

    const argsUnrestricted = await getArgsForConfig({
      ...defaultConfig,
      fullNetwork: true,
    });
    expect(argsUnrestricted).toContain("--cap-add=NET_ADMIN");
  });

  test("includes TCP tuning sysctls", async () => {
    const args = await getArgsForConfig({ ...defaultConfig });
    expect(args).toContain("--sysctl=net.ipv4.tcp_tw_reuse=1");
    expect(args).toContain("--sysctl=net.ipv4.tcp_fin_timeout=10");
    const portRangeArg = args.find((a: string) =>
      a.startsWith("--sysctl=net.ipv4.ip_local_port_range="),
    );
    expect(portRangeArg).toBeDefined();
    // Value uses tab separator (required by Docker)
    expect(portRangeArg).toContain("1024\t65535");
  });

  test("includes container ulimit for file descriptors", async () => {
    const args = await getArgsForConfig({ ...defaultConfig });
    const ulimitIdx = args.indexOf("--ulimit");
    expect(ulimitIdx).toBeGreaterThanOrEqual(0);
    expect(args[ulimitIdx + 1]).toBe("nofile=65536:65536");
  });

  test("includes SANDBOX_FIREWALL with fullNetwork:false in restricted mode", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      fullNetwork: false,
    });
    expect(firewall).not.toBeNull();
    expect(firewall).toHaveProperty("enabled", true);
    expect(firewall).toHaveProperty("fullNetwork", false);
  });

  test("includes SANDBOX_FIREWALL with fullNetwork:true in unrestricted mode", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      fullNetwork: true,
    });
    expect(firewall).not.toBeNull();
    expect(firewall).toHaveProperty("enabled", true);
    expect(firewall).toHaveProperty("fullNetwork", true);
  });

  test("includes allowNetwork in SANDBOX_FIREWALL", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      allowNetwork: [{ host: "github.com", ports: [443], wildcard: false }],
      fullNetwork: false,
    });
    expect(firewall).not.toBeNull();
    expect(firewall).toHaveProperty("allowNetwork");
    const allowNetwork = (firewall as { allowNetwork?: unknown }).allowNetwork;
    expect(Array.isArray(allowNetwork)).toBe(true);
    expect(allowNetwork).toHaveLength(1);
    expect(allowNetwork).toEqual([
      { host: "github.com", ports: [443], wildcard: false },
    ]);
  });

  test("serializes an all-port sentinel without changing policy structure", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      allowNetwork: [{ host: "all.example", ports: "*", wildcard: false }],
      fullNetwork: false,
    });
    expect(firewall).toEqual({
      enabled: true,
      allowNetwork: [{ host: "all.example", ports: "*", wildcard: false }],
      fullNetwork: false,
      noProxy: false,
    });
  });

  test("firewall config does not include proxy field", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      fullNetwork: false,
    });
    expect(firewall).not.toBeNull();
    expect(firewall).not.toHaveProperty("proxy");
  });

  test("firewall config has correct structure", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      allowNetwork: [
        { host: "example.com", ports: [80, 443], wildcard: false },
      ],
      fullNetwork: false,
    });
    expect(firewall).not.toBeNull();
    expect(firewall).toMatchObject({
      enabled: true,
      allowNetwork: [
        { host: "example.com", ports: [80, 443], wildcard: false },
      ],
      fullNetwork: false,
      noProxy: false,
    });
    // Verify no other unexpected fields
    const keys = Object.keys(firewall as object);
    expect(keys.sort()).toEqual(
      ["allowNetwork", "enabled", "fullNetwork", "noProxy"].sort(),
    );
  });

  test("allowNetwork is passed through in fullNetwork mode", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      allowNetwork: [{ host: "github.com", ports: [22, 443], wildcard: false }],
      fullNetwork: true,
    });
    expect(firewall).not.toBeNull();
    expect(firewall).toHaveProperty("allowNetwork");
    const allowNetwork = (firewall as { allowNetwork?: unknown }).allowNetwork;
    expect(allowNetwork).toEqual([
      { host: "github.com", ports: [22, 443], wildcard: false },
    ]);
  });
});

describe("buildContainerArgs - noProxy", () => {
  test("includes noProxy in firewall config when enabled", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      fullNetwork: true,
      noProxy: true,
    });
    expect(firewall).toHaveProperty("noProxy", true);
  });

  test("includes noProxy:false in firewall config by default", async () => {
    const firewall = await getFirewallFromArgs({
      ...defaultConfig,
      fullNetwork: false,
    });
    expect(firewall).toHaveProperty("noProxy", false);
  });

  test("passes SANDBOX_NO_PROXY env var when noProxy is true", async () => {
    const args = await getArgsForConfig({
      ...defaultConfig,
      fullNetwork: true,
      noProxy: true,
    });
    const envIdx = args.indexOf("SANDBOX_NO_PROXY=1");
    expect(envIdx).toBeGreaterThan(-1);
  });

  test("does not pass SANDBOX_NO_PROXY env var when noProxy is false", async () => {
    const args = await getArgsForConfig({
      ...defaultConfig,
      fullNetwork: false,
      noProxy: false,
    });
    expect(args.some((a) => a.includes("SANDBOX_NO_PROXY"))).toBe(false);
  });
});

describe("buildContainerArgs - shmSize", () => {
  test("includes --shm-size when shmSize is set", async () => {
    const args = await getArgsForConfig({
      ...defaultConfig,
      shmSize: "1gb",
    });
    const shmIdx = args.indexOf("--shm-size");
    expect(shmIdx).toBeGreaterThanOrEqual(0);
    expect(args[shmIdx + 1]).toBe("1gb");
  });

  test("does not include --shm-size when shmSize is not set", async () => {
    const args = await getArgsForConfig({ ...defaultConfig });
    expect(args).not.toContain("--shm-size");
  });
});

describe("buildExecArgs - proxy env vars", () => {
  test("passes every proxy variable when proxy mode is enabled", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: true,
    });

    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "GIT_SSH_COMMAND",
      "JAVA_TOOL_OPTIONS",
      "NODE_USE_ENV_PROXY",
    ]) {
      expect(args.some((arg) => arg.startsWith(`${name}=`))).toBe(true);
    }
  });

  test("passes no proxy variables when proxy mode is disabled", () => {
    const args = buildExecArgs({
      containerName: "sandbox-test-a1b2",
      currentDir: "/test/project",
      command: ["zsh"],
      stdin: true,
      tty: true,
      proxyEnabled: false,
    });

    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "NO_PROXY",
      "no_proxy",
      "GIT_SSH_COMMAND",
      "JAVA_TOOL_OPTIONS",
      "NODE_USE_ENV_PROXY",
    ]) {
      expect(args.some((arg) => arg.startsWith(`${name}=`))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildContainerArgs - Named volumes from persist_paths
// ---------------------------------------------------------------------------

describe("buildContainerArgs - Named volumes", () => {
  const nixPersistPath = {
    path: "/nix",
    useNamedVolume: "nix",
    global: false,
    onlyIfExists: false,
  };

  test("includes sandbox-nix:/nix when persist_paths has use_named_volume = 'nix'", async () => {
    const config = createTestConfig({
      persistPaths: [nixPersistPath],
    });
    const { args } = await buildContainerArgs({
      config,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args.some((a) => a.includes("sandbox-nix:/nix"))).toBe(true);
  });

  test("excludes sandbox-nix:/nix when persist_paths has no use_named_volume", async () => {
    const { args } = await buildContainerArgs({
      config: defaultConfig,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args.some((a) => a.includes("sandbox-nix:/nix"))).toBe(false);
  });

  test("supports multiple named volumes from persist_paths", async () => {
    const config = createTestConfig({
      persistPaths: [
        nixPersistPath,
        {
          path: "/data",
          useNamedVolume: "mydata",
          global: false,
          onlyIfExists: false,
        },
      ],
    });
    const { args } = await buildContainerArgs({
      config,
      projectRoot: "/test/project",
      currentDir: "/test/project",
      projectSlug: "test-project-a1b2",
      service: createContainerArgumentRuntime(),
    });
    expect(args.some((a) => a.includes("sandbox-nix:/nix"))).toBe(true);
    expect(args.some((a) => a.includes("sandbox-mydata:/data"))).toBe(true);
  });
});
