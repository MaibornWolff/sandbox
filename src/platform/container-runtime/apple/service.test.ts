import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExecError } from "#platform/process/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import { createAppleImageOperations } from "./images.js";
import type { AppleNetworkOperations } from "./networking.js";
import { AppleContainerService } from "./service.js";

const readyNetwork: AppleNetworkOperations = {
  async prepareBuild() {},
  async prepareRun() {
    return {
      networkName: "default",
      environment: {},
      async [Symbol.asyncDispose]() {},
    };
  },
};

function createImages(
  commands: ReturnType<typeof createStatefulRuntimeCommandExecutor>,
) {
  return createAppleImageOperations(commands.executor, readyNetwork);
}

const containerFixture = JSON.stringify([
  {
    id: "sandbox-project",
    configuration: {
      id: "sandbox-project",
      image: {
        descriptor: { digest: "sha256:image" },
        reference: "sandbox-project:latest",
      },
      labels: { project: "alpha", hash: "123" },
    },
    status: { state: "running", startedDate: "2026-09-11T12:00:00Z" },
  },
  {
    id: "other",
    configuration: {
      id: "other",
      image: {
        descriptor: { digest: "sha256:other" },
        reference: "other:latest",
      },
      labels: { project: "beta" },
    },
    status: { state: "stopped" },
  },
]);

function appleImageFixture(options: {
  readonly id: string;
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly size?: number;
}): string {
  return JSON.stringify([
    {
      id: options.id,
      configuration: {
        ...(options.name ? { name: options.name } : {}),
        descriptor: { digest: options.id, size: options.size ?? 0 },
      },
      variants: [
        {
          platform: { os: "linux", architecture: "arm64" },
          config: { config: { Labels: options.labels ?? {} } },
          size: options.size ?? 0,
        },
      ],
    },
  ]);
}

const imageFixture = JSON.stringify([
  {
    id: "index-id",
    configuration: {
      name: "sandbox-project:latest",
      descriptor: { digest: "sha256:index", size: 100 },
    },
    variants: [
      {
        platform: { os: "linux", architecture: "amd64" },
        config: { config: { Labels: { "dockerfile.hash": "wrong" } } },
      },
      {
        platform: { os: "linux", architecture: "arm64" },
        config: { config: { Labels: { "dockerfile.hash": "right" } } },
      },
    ],
  },
]);

describe("AppleContainerService", () => {
  test("lists and filters containers from Apple JSON", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "container", args: ["list", "-a", "--format", "json"] },
      containerFixture,
    );
    const [firstContainer, secondContainer] = JSON.parse(containerFixture) as [
      unknown,
      unknown,
    ];
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-project"] },
      JSON.stringify([firstContainer]),
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "other"] },
      JSON.stringify([secondContainer]),
    );
    const service = new AppleContainerService(commands.executor);

    const containers = await service.instances.list({
      all: true,
      labels: { project: "alpha", hash: null },
      states: ["running", "paused"],
    });

    expect(containers).toEqual([
      expect.objectContaining({
        id: "sandbox-project",
        name: "sandbox-project",
        image: {
          reference: "sandbox-project:latest",
          digest: "sha256:image",
        },
        labels: { project: "alpha", hash: "123" },
        state: "running",
      }),
    ]);
  });

  test("returns instance labels unchanged", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-project"] },
      JSON.stringify([
        {
          id: "sandbox-project",
          configuration: {
            image: {
              descriptor: { digest: "sha256:image" },
              reference: "sandbox-project:latest",
            },
            labels: {
              "sandbox.hash": "expected",
              "sandbox.internal.apple-compatibility": "stored",
            },
          },
          status: { state: "running" },
        },
      ]),
    );
    const service = new AppleContainerService(commands.executor);

    const instance = await service.instances.inspect("sandbox-project");
    expect(instance?.labels).toEqual({
      "sandbox.hash": "expected",
      "sandbox.internal.apple-compatibility": "stored",
    });
    expect(commands.events()).toHaveLength(1);
  });

  test("resolves compatibility identity on every call", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "container",
        args: ["network", "list", "--format", "json"],
      },
      JSON.stringify([
        {
          id: "default",
          configuration: { name: "default", creationDate: "2026-09-15" },
          status: {
            ipv4Gateway: "192.168.64.1",
            ipv4Subnet: "192.168.64.0/24",
            ipv6Subnet: "fd00::/64",
          },
        },
      ]),
    );
    const service = new AppleContainerService(commands.executor);

    const first = await service.getCompatibilityIdentity();
    const second = await service.getCompatibilityIdentity();

    expect(second).toBe(first);
    expect(commands.events()).toHaveLength(2);
  });

  test("rejects malformed container JSON", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "container", args: ["list", "--format", "json"] },
      "not-json",
    );
    await expect(
      new AppleContainerService(commands.executor).instances.list(),
    ).rejects.toThrow("invalid container list JSON");
  });

  test("uses Apple log tail syntax", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "container",
        args: ["logs", "-n", "25", "sandbox-project"],
      },
      "logs",
    );
    await expect(
      new AppleContainerService(commands.executor).instances.readLogs(
        "sandbox-project",
        { tail: 25 },
      ),
    ).resolves.toBe("logs");
  });

  test("runs the typed lifecycle and normalizes Apple mounts", async () => {
    const root = createTestDir("apple-container-operations");
    using _cleanup = {
      [Symbol.dispose]: () => cleanupTestDir(root),
    };
    const commands = createStatefulRuntimeCommandExecutor();
    const volumePath = path.join(
      root,
      ".local",
      "share",
      "sandbox",
      "apple-container-volumes",
      "cache",
    );
    fs.mkdirSync(volumePath, { recursive: true });
    fs.writeFileSync(path.join(volumePath, "existing-data"), "preserved");
    const networkList = JSON.stringify([
      {
        id: "default",
        configuration: { name: "default", creationDate: "2026-09-15" },
        status: {
          ipv4Gateway: "192.168.64.1",
          ipv4Subnet: "192.168.64.0/24",
          ipv6Subnet: "fd00::/64",
        },
      },
    ]);
    commands.givenOutput(
      {
        command: "container",
        args: ["network", "list", "--format", "json"],
      },
      networkList,
    );
    const createArgs = [
      "create",
      "--rm",
      "--init",
      "--name",
      "sandbox-project",
      "--network",
      "default",
      "--label",
      "project=alpha",
      "-e",
      "SANDBOX=1",
      "-e",
      `SANDBOX_GUEST_HOST_MAPPINGS=${JSON.stringify([
        { host: "host.container.internal", address: "192.168.64.1" },
        { host: "host.docker.internal", address: "192.168.64.1" },
      ])}`,
      "-v",
      `${volumePath}:/cache:rw`,
      "--cap-add",
      "NET_ADMIN",
      "sandbox-project:latest",
    ];
    commands.givenOutput(
      { command: "container", args: createArgs },
      "sandbox-project",
    );
    commands.givenOutput(
      { command: "container", args: ["start", "sandbox-project"] },
      "",
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "sandbox-project"] },
      JSON.stringify([
        {
          id: "sandbox-project",
          configuration: {
            image: {
              descriptor: { digest: "sha256:image" },
              reference: "sandbox-project:latest",
            },
            labels: { project: "alpha" },
            mounts: [
              {
                source: volumePath,
                destination: "/cache",
                options: ["rw"],
              },
              {
                source: "/host/project",
                destination: "/workspace",
                options: ["ro"],
              },
            ],
          },
          status: { state: "stopped", startedDate: "2026-09-11T12:00:00Z" },
        },
      ]),
    );
    commands.givenOutput(
      {
        command: "container",
        args: ["kill", "--signal", "SIGTERM", "sandbox-project"],
      },
      "",
    );
    commands.givenOutput(
      { command: "container", args: ["stop", "sandbox-project"] },
      "",
    );
    commands.givenFailure(
      { command: "container", args: ["delete", "sandbox-project"] },
      new ExecError("container not found", 1, {
        stderr: "Error: container not found: sandbox-project",
      }),
    );
    commands.givenOutput(
      {
        command: "container",
        args: ["delete", "-f", "obsolete"],
      },
      "",
    );
    commands.givenFailure(
      {
        command: "container",
        args: [
          "exec",
          "-u",
          "sandbox",
          "-w",
          "/workspace",
          "-e",
          "CHECK=1",
          "sandbox-project",
          "false",
        ],
      },
      new ExecError("command failed", 17, { stdout: "out", stderr: "err" }),
    );
    const service = new AppleContainerService(commands.executor);

    await runWithTestLogger(
      async () => {
        await service.withInstanceStartup(async () => {
          await service.getCompatibilityIdentity();
          await service.instances.startDetached({
            name: "sandbox-project",
            image: {
              reference: "sandbox-project:latest",
              digest: "sha256:image",
            },
            labels: { project: "alpha" },
            environment: { SANDBOX: "1" },
            mounts: [
              {
                type: "storage",
                storage: { id: "cache" },
                targetPath: "/cache",
                readOnly: false,
              },
            ],
            ports: [],
            init: true,
            removeOnExit: true,
            resources: {},
            security: {
              capabilities: ["NET_ADMIN"],
              nestedContainerRuntime: false,
            },
          });
        });
        expect(
          commands.events().filter((event) => event.args[0] === "network"),
        ).toHaveLength(1);
        await expect(
          service.instances.inspect("sandbox-project"),
        ).resolves.toMatchObject({
          state: "exited",
          mounts: [
            {
              type: "storage",
              storage: { id: "cache" },
              targetPath: "/cache",
              readOnly: false,
            },
            {
              type: "workspace",
              sourcePath: "/host/project",
              targetPath: "/workspace",
              readOnly: true,
            },
          ],
        });
        await service.instances.signal("sandbox-project", "SIGTERM");
        await service.instances.stopAndRemove("sandbox-project");
        await service.instances.remove("obsolete", { force: true });
        await expect(
          service.instances.exec("sandbox-project", {
            command: ["false"],
            user: "sandbox",
            workingDirectory: "/workspace",
            environment: { CHECK: "1" },
          }),
        ).resolves.toEqual({ exitCode: 17, stdout: "out", stderr: "err" });
      },
      { homeDirectory: root },
    );

    expect(fs.existsSync(volumePath)).toBe(true);
  });

  test("selects ARM64 image labels and index identity", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "container",
        args: ["image", "inspect", "sandbox-project:latest"],
      },
      imageFixture,
    );
    await expect(
      createImages(commands).inspect("sandbox-project:latest"),
    ).resolves.toEqual({
      id: "sha256:index",
      references: ["sandbox-project:latest"],
      labels: { "dockerfile.hash": "right" },
      sizeBytes: 0,
    });
  });

  test("returns a runtime-resolvable Apple reference with an immutable digest", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "container",
        args: ["image", "inspect", "sandbox-project:latest"],
      },
      imageFixture,
    );
    const service = new AppleContainerService(commands.executor);

    await expect(
      service.build({
        contextDirectory: "/tmp",
        dockerfilePath: "/tmp/Dockerfile",
        tag: "sandbox-project:latest",
        buildArguments: {},
        labels: { "dockerfile.hash": "right" },
        secrets: [],
        cachePolicy: "use",
        output: "silent",
      }),
    ).resolves.toEqual({
      reference: "sandbox-project:latest",
      digest: "sha256:index",
    });
  });

  test("refuses the created instance when a tag mutates after image inspection", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "container",
        args: ["image", "inspect", "sandbox-project:latest"],
      },
      imageFixture,
    );
    commands.givenOutput(
      {
        command: "container",
        args: ["network", "list", "--format", "json"],
      },
      JSON.stringify([
        {
          id: "default",
          configuration: { name: "default", creationDate: "2026-09-15" },
          status: {
            ipv4Gateway: "192.168.64.1",
            ipv4Subnet: "192.168.64.0/24",
            ipv6Subnet: "fd00::/64",
          },
        },
      ]),
    );
    const createArgs = [
      "create",
      "--rm",
      "--init",
      "--name",
      "sandbox-project",
      "--network",
      "default",
      "-e",
      `SANDBOX_GUEST_HOST_MAPPINGS=${JSON.stringify([
        { host: "host.container.internal", address: "192.168.64.1" },
        { host: "host.docker.internal", address: "192.168.64.1" },
      ])}`,
      "sandbox-project:latest",
    ];
    commands.givenOutput(
      { command: "container", args: createArgs },
      "created-instance",
    );
    commands.givenOutput(
      { command: "container", args: ["inspect", "created-instance"] },
      JSON.stringify([
        {
          id: "created-instance",
          configuration: {
            image: {
              descriptor: { digest: "sha256:mutated" },
              reference: "sandbox-project:latest",
            },
          },
          status: { state: "stopped" },
        },
      ]),
    );
    commands.givenOutput(
      { command: "container", args: ["delete", "created-instance"] },
      "",
    );
    const service = new AppleContainerService(commands.executor);
    const image = await service.build({
      contextDirectory: "/tmp",
      dockerfilePath: "/tmp/Dockerfile",
      tag: "sandbox-project:latest",
      buildArguments: {},
      labels: { "dockerfile.hash": "right" },
      secrets: [],
      cachePolicy: "use",
      output: "silent",
    });

    await expect(
      service.instances.startDetached({
        name: "sandbox-project",
        image,
        labels: {},
        environment: {},
        mounts: [],
        ports: [],
        init: true,
        removeOnExit: true,
        resources: {},
        security: { capabilities: [], nestedContainerRuntime: false },
      }),
    ).rejects.toThrow(
      "created instance created-instance from sha256:mutated, expected sha256:index",
    );
    expect(
      commands
        .events()
        .filter(
          (event) => event.command === "container" && event.args[0] === "image",
        ),
    ).toHaveLength(1);
    expect(commands.events()).not.toContainEqual({
      command: "container",
      args: ["start", "created-instance"],
    });
  });

  test("builds with Apple secret transport and typed policies", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const args = [
      "build",
      "--no-cache",
      "--build-arg",
      "HOST_UID=1000",
      "--secret",
      "id=GITHUB_TOKEN,env=GITHUB_TOKEN",
      "--label",
      "sandbox.managed=true",
      "-t",
      "sandbox-base:latest",
      "-f",
      "/tmp/Dockerfile",
      "/tmp",
    ];
    commands.givenOutput({ command: "container", args }, "");
    commands.givenOutput(
      {
        command: "container",
        args: ["image", "inspect", "sandbox-base:latest"],
      },
      appleImageFixture({
        id: "sha256:built",
        name: "sandbox-base:latest",
        labels: { "sandbox.managed": "true" },
      }),
    );
    const images = createImages(commands);

    await expect(
      runWithTestLogger(() =>
        images.build({
          contextDirectory: "/tmp",
          dockerfilePath: "/tmp/Dockerfile",
          tag: "sandbox-base:latest",
          buildArguments: { HOST_UID: "1000" },
          labels: { "sandbox.managed": "true" },
          secrets: [
            { id: "GITHUB_TOKEN", environmentVariable: "GITHUB_TOKEN" },
          ],
          cachePolicy: "bypass",
          output: "silent",
        }),
      ),
    ).resolves.toMatchObject({ id: "sha256:built" });
    expect(commands.events()[0]?.options).toEqual({ interactive: false });
  });

  test("cleans only untagged, managed, unused Apple images", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "container", args: ["image", "inspect", "unmanaged"] },
      appleImageFixture({ id: "unmanaged" }),
    );
    commands.givenOutput(
      { command: "container", args: ["image", "inspect", "tagged"] },
      appleImageFixture({
        id: "tagged",
        name: "sandbox-base:latest",
        labels: { "sandbox.managed": "true" },
      }),
    );
    commands.givenOutput(
      { command: "container", args: ["image", "inspect", "used"] },
      appleImageFixture({
        id: "used",
        labels: { "sandbox.managed": "true" },
      }),
    );
    commands.givenOutput(
      { command: "container", args: ["list", "-a", "--format", "json"] },
      JSON.stringify([
        {
          id: "consumer",
          configuration: { image: { descriptor: { digest: "used" } } },
        },
      ]),
    );
    commands.givenOutput(
      { command: "container", args: ["image", "inspect", "remove"] },
      appleImageFixture({
        id: "remove",
        labels: { "sandbox.managed": "true" },
        size: 2_000,
      }),
    );
    commands.givenOutput(
      { command: "container", args: ["image", "delete", "remove"] },
      "",
    );

    const result = await createImages(commands).removeUnused({
      candidates: ["unmanaged", "tagged", "used", "remove"],
      managedLabel: { key: "sandbox.managed", value: "true" },
    });
    expect(result).toEqual({
      removed: [{ id: "remove", estimatedReclaimedBytes: 2_000 }],
      skipped: [
        { id: "unmanaged", reason: "unmanaged" },
        { id: "tagged", reason: "tagged" },
        { id: "used", reason: "in-use" },
      ],
      estimatedReclaimedBytes: 2_000,
    });
  });

  test("returns null only for a missing image", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "container", args: ["image", "inspect", "missing"] },
      new ExecError("image not found", 1, {
        stderr: "Error: image not found: missing",
      }),
    );
    await expect(createImages(commands).inspect("missing")).resolves.toBeNull();
  });

  test("preserves unexpected image inspection failures", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "container", args: ["image", "inspect", "image"] },
      new ExecError("service unavailable", 1, {
        stderr: "service unavailable",
      }),
    );
    await expect(createImages(commands).inspect("image")).rejects.toThrow(
      "service unavailable",
    );
  });

  test("checks Apple host prerequisites", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput({ command: "uname", args: ["-m"] }, "arm64\n");
    commands.givenOutput(
      { command: "sw_vers", args: ["-productVersion"] },
      "26.5.1\n",
    );
    commands.givenOutput(
      { command: "container", args: ["--version"] },
      "container CLI version 1.4.1\n",
    );
    commands.givenOutput(
      {
        command: "container",
        args: ["system", "status", "--format", "json"],
      },
      '{"status":"running"}',
    );

    await expect(
      runWithTestLogger(
        () => new AppleContainerService(commands.executor).ensureHostReady(),
        { platform: "darwin" },
      ),
    ).resolves.toEqual({
      version: "container CLI version 1.4.1",
      hostAccessName: "host.container.internal",
      memory: { bytes: 2 * 1024 ** 3, scope: "per-instance-default" },
    });
  });
});
