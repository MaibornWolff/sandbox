import { describe, expect, test } from "bun:test";
import type { Config } from "#modules/configuration/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import {
  cleanupTestDir,
  createTestConfig,
  createTestDir,
} from "#test/utils.js";
import { buildSandboxInstanceSpec } from "./container-arguments.js";

const runtimePackage = {
  id: `1.70.0-${"a".repeat(64)}`,
  mount: {
    hostPath: "/test/data/sandbox/runtime/1.70.0-test",
    containerPath: "/opt/sandbox-cli",
    mode: "ro" as const,
  },
  [Symbol.asyncDispose]: () => Promise.resolve(),
};

const repositoryRoots = { worktreeRoot: null, mainRepoRoot: null };

function createScope(): Disposable & { readonly root: string } {
  const root = createTestDir("container-arguments");
  return { root, [Symbol.dispose]: () => cleanupTestDir(root) };
}

async function buildSpec(
  config: Config = createTestConfig(),
  options: {
    readonly runtime?: "apple-container" | "docker" | "podman";
    readonly hostName?: string;
    readonly projectRoot?: string;
    readonly variables?: Readonly<Record<string, string>>;
  } = {},
) {
  using scope = createScope();
  return await runWithTestLogger(
    () =>
      buildSandboxInstanceSpec(
        {
          runtime: options.runtime ?? "docker",
          hostAccessName: options.hostName ?? "host.docker.internal",
          storage: {
            ensure: async ({ key }) => ({ id: key }),
            find: async () => null,
            remove: async () => undefined,
          },
        },
        {
          config,
          projectRoot: options.projectRoot ?? "/test/project",
          currentDir: options.projectRoot ?? "/test/project",
          projectSlug: "test-project-a1b2",
          repositoryRoots,
          runtimePackage,
        },
      ),
    { variables: options.variables, homeDirectory: scope.root },
  );
}

describe("buildSandboxInstanceSpec", () => {
  test("builds structural labels and environment", async () => {
    const spec = await buildSpec(createTestConfig(), {
      runtime: "apple-container",
      hostName: "host.container.internal",
    });
    expect(spec.name).toBe("");
    expect(spec.labels).toMatchObject({
      "sandbox.project": "test-project-a1b2",
      "sandbox.runtime": runtimePackage.id,
    });
    expect(spec.environment).toMatchObject({
      SANDBOX: "1",
      SANDBOX_RUNTIME: "apple-container",
      SANDBOX_HOST_ACCESS_NAME: "host.container.internal",
    });
    expect(spec.security).toEqual({
      capabilities: ["NET_ADMIN"],
      nestedContainerRuntime: false,
    });
  });

  test("keeps configured values out of the startup environment", async () => {
    const spec = await buildSpec(
      { ...createTestConfig(), env: ["TOKEN=resolved", "MODE=test"] },
      { variables: { TOKEN: "secret", CLAUDE_CODE_SSE_PORT: "23456" } },
    );
    expect(spec.environment).not.toHaveProperty("TOKEN");
    expect(spec.environment).not.toHaveProperty("MODE");
    expect(spec.environment.CLAUDE_CODE_SSE_PORT).toBe("23456");
  });

  test("preserves native Windows sources and Linux targets", async () => {
    const spec = await buildSpec(
      {
        ...createTestConfig(),
        mounts: ["C:\\Users\\test:/data:ro"],
      },
      { projectRoot: "C:\\project" },
    );
    expect(spec.mounts).toContainEqual({
      type: "workspace",
      sourcePath: "C:\\Users\\test",
      targetPath: "/data",
      readOnly: true,
    });
    expect(spec.mounts[0]).toEqual({
      type: "workspace",
      sourcePath: "C:\\project",
      targetPath: "/mnt/c/project",
      readOnly: false,
    });
  });

  test("preserves mount order and nested writable mounts", async () => {
    const spec = await buildSpec({
      ...createTestConfig(),
      mounts: ["/data:/workspace/data:ro", "/cache:/workspace/data/cache:rw"],
    });
    const custom = spec.mounts.filter(
      (mount) =>
        mount.type === "workspace" &&
        ["/data", "/cache"].includes(mount.sourcePath),
    );
    expect(custom).toEqual([
      {
        type: "workspace",
        sourcePath: "/data",
        targetPath: "/workspace/data",
        readOnly: true,
      },
      {
        type: "workspace",
        sourcePath: "/cache",
        targetPath: "/workspace/data/cache",
        readOnly: false,
      },
    ]);
  });

  test("expands port ranges and preserves addresses and protocols", async () => {
    const spec = await buildSpec({
      ...createTestConfig(),
      ports: ["127.0.0.1:8000-8001:9000-9001/udp", "3000:3000"],
    });
    expect(spec.ports).toEqual([
      {
        hostAddress: "127.0.0.1",
        hostPort: 8000,
        instancePort: 9000,
        protocol: "udp",
      },
      {
        hostAddress: "127.0.0.1",
        hostPort: 8001,
        instancePort: 9001,
        protocol: "udp",
      },
      { hostPort: 3000, instancePort: 3000, protocol: "tcp" },
    ]);
  });

  test("represents shared memory and named volumes", async () => {
    const spec = await buildSpec({
      ...createTestConfig(),
      shmSize: "2g",
      persistPaths: [
        {
          path: "/nix",
          global: false,
          onlyIfExists: false,
          useNamedVolume: "nix",
        },
      ],
    });
    expect(spec.resources).toEqual({ sharedMemorySize: "2g" });
    expect(spec.mounts).toContainEqual({
      type: "storage",
      storage: { id: "sandbox-nix" },
      targetPath: "/nix",
      readOnly: false,
    });
  });

  test("stores normalized network policy", async () => {
    const spec = await buildSpec({
      ...createTestConfig(),
      fullNetwork: true,
      noProxy: true,
    });
    expect(JSON.parse(spec.environment.SANDBOX_FIREWALL ?? "")).toMatchObject({
      enabled: true,
      fullNetwork: true,
      noProxy: true,
    });
    expect(spec.environment.SANDBOX_NO_PROXY).toBe("1");
  });
});
