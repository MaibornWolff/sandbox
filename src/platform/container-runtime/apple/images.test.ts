import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { ExecError } from "#platform/process/index.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import type { RuntimeExecutor } from "../executor.js";
import type { ImageBuildSpec } from "../image-contract.js";
import { createAppleImageOperations } from "./images.js";
import type { AppleNetworkOperations } from "./networking.js";

const readyNetwork: AppleNetworkOperations = {
  async prepareBuild() {},
  async prepareRun() {
    throw new Error("Run preparation is not used by image tests.");
  },
};

function createImages(exec: RuntimeExecutor) {
  return createAppleImageOperations(exec, readyNetwork);
}

const fixturePath = path.join(
  import.meta.dir,
  "__fixtures__",
  "1.4.1",
  "image-inspect.json",
);

function readFixture(): string {
  return fs.readFileSync(fixturePath, "utf8");
}

function imageFixture(options: {
  readonly id: string;
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly size?: number;
}): string {
  return JSON.stringify([
    {
      configuration: {
        descriptor: { digest: options.id, size: options.size ?? 0 },
        ...(options.name ? { name: options.name } : {}),
      },
      variants: [
        {
          platform: { os: "linux", architecture: "arm64", variant: "v8" },
          config: { config: { Labels: options.labels ?? {} } },
          size: options.size ?? 0,
        },
      ],
    },
  ]);
}

function buildSpec(): ImageBuildSpec {
  return {
    contextDirectory: "/tmp/context",
    dockerfilePath: "/tmp/context/Containerfile",
    tag: "sandbox-project:latest",
    buildArguments: { HOST_UID: "1000", BASE_IMAGE: "sandbox-user:latest" },
    labels: { "sandbox.managed": "true", "dockerfile.hash": "abc" },
    secrets: [{ id: "GITHUB_TOKEN", environmentVariable: "GITHUB_TOKEN" }],
    cachePolicy: "bypass",
    output: "silent",
  };
}

async function runWithCapturedLogger<T>(callback: () => Promise<T>): Promise<{
  readonly result: T;
  readonly output: string;
}> {
  const messages: string[] = [];
  const result = await runWithDependencies(
    [
      provideHostEnvironment(
        createHostEnvironment({
          currentWorkingDirectory: "/project",
          homeDirectory: "/home/test",
          variables: { GITHUB_TOKEN: "secret-value" },
          platform: "darwin",
          interactive: false,
        }),
      ),
      provideLogger(
        createLogger(
          { now: () => 0, sleep: () => Promise.resolve() },
          (message) => messages.push(message),
          { verbose: true },
        ),
      ),
    ],
    callback,
  );
  return { result, output: messages.join("\n") };
}

describe("Apple container 1.4.1 image operations", () => {
  test.each(["", "sha256:"])(
    "inspects a complete content identity with prefix %s through the inventory",
    async (prefix) => {
      const commands = createStatefulRuntimeCommandExecutor();
      const digest = `sha256:${"1".repeat(64)}`;
      const reference = `${prefix}${"1".repeat(64)}`;
      commands.givenOutput(
        { command: "container", args: ["image", "list", "--format", "json"] },
        readFixture(),
      );
      const images = createImages(commands.executor);
      expect(await images.inspect(reference)).toMatchObject({
        id: digest,
      });
      const cleanup = await images.removeUnused({
        candidates: [reference],
        managedLabel: { key: "sandbox.managed", value: "true" },
      });
      expect(cleanup.removed).toHaveLength(0);
      expect(cleanup.skipped).toEqual([{ id: reference, reason: "tagged" }]);
    },
  );

  test("parses opaque index identity and Linux ARM64 labels from realistic data", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      {
        command: "container",
        args: ["image", "inspect", "sandbox-project:latest"],
      },
      readFixture(),
    );
    const images = createImages(commands.executor);

    await expect(images.inspect("sandbox-project:latest")).resolves.toEqual({
      id: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      references: ["sandbox-project:latest"],
      labels: {
        "dockerfile.hash": "arm64-value",
        "sandbox.managed": "true",
      },
      sizeBytes: 1900,
    });
    expect(commands.events()).toHaveLength(1);
  });

  test("rejects malformed, empty, incomplete, and unsupported-platform output", async () => {
    const cases = [
      { output: "not-json", message: "invalid image inspection JSON" },
      { output: "[]", message: "invalid image inspection" },
      {
        output: JSON.stringify([{ variants: [] }]),
        message: "has no identity",
      },
      {
        output: JSON.stringify([
          {
            configuration: { descriptor: { digest: "sha256:image" } },
            variants: [{ platform: { os: "linux", architecture: "amd64" } }],
          },
        ]),
        message: "no Linux ARM64 variant",
      },
    ];
    for (const testCase of cases) {
      const commands = createStatefulRuntimeCommandExecutor();
      commands.givenOutput(
        { command: "container", args: ["image", "inspect", "image"] },
        testCase.output,
      );
      await expect(
        createImages(commands.executor).inspect("image"),
      ).rejects.toThrow(testCase.message);
    }
  });

  test("returns null only for explicit absence and preserves process failures", async () => {
    const missing = createStatefulRuntimeCommandExecutor();
    missing.givenFailure(
      { command: "container", args: ["image", "inspect", "missing"] },
      new ExecError("unknown lookup failure", 1),
    );
    missing.givenOutput(
      { command: "container", args: ["image", "list", "--format", "json"] },
      "[]",
    );
    await expect(
      createImages(missing.executor).inspect("missing"),
    ).resolves.toBeNull();

    const failed = createStatefulRuntimeCommandExecutor();
    const failure = new ExecError("service unavailable", 125);
    failed.givenFailure(
      { command: "container", args: ["image", "inspect", "image"] },
      failure,
    );
    failed.givenFailure(
      { command: "container", args: ["image", "list", "--format", "json"] },
      failure,
    );
    await expect(createImages(failed.executor).inspect("image")).rejects.toBe(
      failure,
    );
  });

  test.each(["image", "image:latest", "sha256:abcd", "image@sha256:abcd"])(
    "preserves inspection failures for an existing reference: %s",
    async (reference) => {
      const commands = createStatefulRuntimeCommandExecutor();
      const failure = new ExecError(
        "permission denied: image not found: image",
        1,
      );
      commands.givenFailure(
        { command: "container", args: ["image", "inspect", reference] },
        failure,
      );
      commands.givenOutput(
        { command: "container", args: ["image", "list", "--format", "json"] },
        imageFixture({ id: "sha256:abcd", name: "image:latest" }),
      );
      await expect(
        createImages(commands.executor).inspect(reference),
      ).rejects.toBe(failure);
    },
  );

  test.each([
    ["not-json", "invalid image list JSON"],
    ["[null]", "invalid image list data"],
    ["[{}]", "missing identity or reference data"],
  ])(
    "does not treat an invalid image list as absence: %s",
    async (output, message) => {
      const commands = createStatefulRuntimeCommandExecutor();
      commands.givenFailure(
        { command: "container", args: ["image", "inspect", "missing"] },
        new ExecError("lookup failed", 1),
      );
      commands.givenOutput(
        { command: "container", args: ["image", "list", "--format", "json"] },
        output,
      );
      await expect(
        createImages(commands.executor).inspect("missing"),
      ).rejects.toThrow(message);
    },
  );

  test("encodes all supported build behavior without Docker-only flags or secrets", async () => {
    const commands = createStatefulRuntimeCommandExecutor();
    const spec = buildSpec();
    const args = [
      "build",
      "--no-cache",
      "--build-arg",
      "HOST_UID=1000",
      "--build-arg",
      "BASE_IMAGE=sandbox-user:latest",
      "--secret",
      "id=GITHUB_TOKEN,env=GITHUB_TOKEN",
      "--label",
      "sandbox.managed=true",
      "--label",
      "dockerfile.hash=abc",
      "-t",
      spec.tag,
      "-f",
      spec.dockerfilePath,
      spec.contextDirectory,
    ];
    commands.givenOutput({ command: "container", args }, "");
    commands.givenOutput(
      { command: "container", args: ["image", "inspect", spec.tag] },
      imageFixture({ id: "sha256:built", name: spec.tag, labels: spec.labels }),
    );

    const { result, output } = await runWithCapturedLogger(() =>
      createImages(commands.executor).build(spec),
    );

    expect(result.id).toBe("sha256:built");
    expect(commands.events()[0]?.options).toEqual({ interactive: false });
    expect(args).not.toContain("--load");
    expect(args).not.toContain("DOCKER_BUILDKIT");
    expect(args.join(" ")).not.toContain("secret-value");
    expect(output).not.toContain("secret-value");
    expect(args).not.toContain("--memory");
  });

  test("rechecks tags before deleting a cleanup candidate", async () => {
    let inspections = 0;
    const events: string[][] = [];
    const executor: RuntimeExecutor = async (_command, args = []) => {
      events.push([...args]);
      if (args[0] === "image" && args[1] === "inspect") {
        inspections++;
        return imageFixture({
          id: "sha256:candidate",
          ...(inspections === 2 ? { name: "rescued:latest" } : {}),
          labels: { "sandbox.managed": "true" },
          size: 400,
        });
      }
      if (args[0] === "list") return "[]";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };

    await expect(
      createImages(executor).removeUnused({
        candidates: ["sha256:candidate"],
        managedLabel: { key: "sandbox.managed", value: "true" },
      }),
    ).resolves.toEqual({
      removed: [],
      skipped: [{ id: "sha256:candidate", reason: "tagged" }],
      estimatedReclaimedBytes: 0,
    });
    expect(events.some((args) => args[1] === "delete")).toBe(false);
  });

  test("rechecks ownership before deleting a cleanup candidate", async () => {
    let inspections = 0;
    const events: string[][] = [];
    const executor: RuntimeExecutor = async (_command, args = []) => {
      events.push([...args]);
      if (args[0] === "image" && args[1] === "inspect") {
        inspections++;
        return imageFixture({
          id: "sha256:candidate",
          labels: inspections === 1 ? { "sandbox.managed": "true" } : {},
        });
      }
      if (args[0] === "list") return "[]";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };

    const result = await createImages(executor).removeUnused({
      candidates: ["sha256:candidate"],
      managedLabel: { key: "sandbox.managed", value: "true" },
    });

    expect(result.skipped).toEqual([
      { id: "sha256:candidate", reason: "unmanaged" },
    ]);
    expect(events.some((args) => args[1] === "delete")).toBe(false);
  });

  test("uses exact digest and reference matches and rechecks container use", async () => {
    let lists = 0;
    const events: string[][] = [];
    const executor: RuntimeExecutor = async (_command, args = []) => {
      events.push([...args]);
      if (args[0] === "image" && args[1] === "inspect") {
        return imageFixture({
          id: "sha256:candidate",
          labels: { "sandbox.managed": "true" },
        });
      }
      if (args[0] === "list") {
        lists++;
        return JSON.stringify(
          lists === 1
            ? [
                {
                  id: "ancestor-only",
                  configuration: {
                    id: "ancestor-only",
                    image: {
                      descriptor: { digest: "sha256:parent" },
                      reference: "candidate-parent:latest",
                    },
                  },
                },
              ]
            : [
                {
                  id: "new-user",
                  configuration: {
                    id: "new-user",
                    image: { descriptor: { digest: "sha256:candidate" } },
                  },
                },
              ],
        );
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    };

    const result = await createImages(executor).removeUnused({
      candidates: ["sha256:candidate"],
      managedLabel: { key: "sandbox.managed", value: "true" },
    });

    expect(result.skipped).toEqual([
      { id: "sha256:candidate", reason: "in-use" },
    ]);
    expect(events.some((args) => args[1] === "delete")).toBe(false);
  });

  test("preserves cleanup inspection, use-check, and deletion failures", async () => {
    const stages = ["inspect", "list", "delete"] as const;
    for (const stage of stages) {
      const failure = new ExecError(`${stage} failed`, 31);
      let inspections = 0;
      const executor: RuntimeExecutor = async (_command, args = []) => {
        if (args[0] === "image" && args[1] === "inspect") {
          inspections++;
          if (stage === "inspect" && inspections === 2) throw failure;
          return imageFixture({
            id: "sha256:candidate",
            labels: { "sandbox.managed": "true" },
          });
        }
        if (args[0] === "image" && args[1] === "list") throw failure;
        if (args[0] === "list") {
          if (stage === "list") throw failure;
          return "[]";
        }
        if (args[0] === "image" && args[1] === "delete") {
          if (stage === "delete") throw failure;
          return "";
        }
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      };
      await expect(
        createImages(executor).removeUnused({
          candidates: ["sha256:candidate"],
          managedLabel: { key: "sandbox.managed", value: "true" },
        }),
      ).rejects.toBe(failure);
      expect(failure.exitCode).toBe(31);
    }
  });
});
