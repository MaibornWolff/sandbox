import { describe, expect, test } from "bun:test";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import {
  createHostEnvironment,
  provideHostEnvironment,
} from "#platform/environment/index.js";
import { createLogger, provideLogger } from "#platform/logging/index.js";
import { ExecError } from "#platform/process/index.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import type { ImageBuildSpec, ImageOperations } from "../image-contract.js";
import { createDockerImageOperations } from "./images.js";

function imageJson(options: {
  readonly id: string;
  readonly references?: readonly string[] | null;
  readonly labels?: Readonly<Record<string, string>> | null;
  readonly size?: number;
}): string {
  return JSON.stringify([
    {
      Id: options.id,
      RepoTags: options.references ?? null,
      Size: options.size ?? 0,
      Config: { Labels: options.labels ?? null },
    },
  ]);
}

function buildSpec(): ImageBuildSpec {
  return {
    contextDirectory: "/tmp/context",
    dockerfilePath: "/tmp/context/Dockerfile",
    tag: "sandbox-base:latest",
    buildArguments: { HOST_UID: "1000" },
    labels: { "sandbox.managed": "true" },
    secrets: [{ id: "GITHUB_TOKEN", environmentVariable: "GITHUB_TOKEN" }],
    cachePolicy: "bypass",
    output: "silent",
  };
}

async function runWithLogger<T>(callback: () => Promise<T>): Promise<{
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
          variables: { GITHUB_TOKEN: "ghp_secret" },
          platform: "linux",
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

const runtimes: readonly {
  readonly name: string;
  readonly binary: "docker" | "podman";
  readonly create: (
    executor: Parameters<typeof createDockerImageOperations>[1],
  ) => { readonly images: ImageOperations };
  readonly loadArgs: readonly string[];
  readonly buildEnvironment: Readonly<Record<string, string>>;
}[] = [
  {
    name: "Docker",
    binary: "docker" as const,
    create: (executor) => ({
      images: createDockerImageOperations("docker", executor, {
        loadResult: true,
        environment: { DOCKER_BUILDKIT: "1" },
      }),
    }),
    loadArgs: ["--load"],
    buildEnvironment: { DOCKER_BUILDKIT: "1" },
  },
  {
    name: "Podman",
    binary: "podman" as const,
    create: (executor) => ({
      images: createDockerImageOperations("podman", executor, {
        loadResult: false,
        environment: {},
      }),
    }),
    loadArgs: [],
    buildEnvironment: {},
  },
];

for (const runtimeCase of runtimes) {
  describe(`${runtimeCase.name} image operations`, () => {
    test("returns complete image inspection data", async () => {
      const commands = createStatefulRuntimeCommandExecutor();
      commands.givenOutput(
        {
          command: runtimeCase.binary,
          args: ["image", "inspect", "sha256:managed"],
        },
        imageJson({
          id: "sha256:managed",
          references: [],
          labels: { "sandbox.managed": "true", other: "value" },
          size: 1_500,
        }),
      );
      const service = runtimeCase.create(commands.executor);

      await expect(service.images.inspect("sha256:managed")).resolves.toEqual({
        id: "sha256:managed",
        references: [],
        labels: { "sandbox.managed": "true", other: "value" },
        sizeBytes: 1_500,
      });
    });

    test("returns null only for a missing image", async () => {
      const missing = createStatefulRuntimeCommandExecutor();
      missing.givenFailure(
        {
          command: runtimeCase.binary,
          args: ["image", "inspect", "missing"],
        },
        new ExecError("No such image", 1, { stderr: "No such image" }),
      );
      await expect(
        runtimeCase.create(missing.executor).images.inspect("missing"),
      ).resolves.toBeNull();

      const unavailable = createStatefulRuntimeCommandExecutor();
      const failure = new ExecError("daemon unavailable", 125, {
        stderr: "daemon unavailable",
      });
      unavailable.givenFailure(
        {
          command: runtimeCase.binary,
          args: ["image", "inspect", "image"],
        },
        failure,
      );
      await expect(
        runtimeCase.create(unavailable.executor).images.inspect("image"),
      ).rejects.toBe(failure);

      const malformed = createStatefulRuntimeCommandExecutor();
      malformed.givenOutput(
        {
          command: runtimeCase.binary,
          args: ["image", "inspect", "image"],
        },
        "not-json",
      );
      await expect(
        runtimeCase.create(malformed.executor).images.inspect("image"),
      ).rejects.toThrow("invalid image inspection JSON");
    });

    test("builds with typed policy and adapter-owned secret transport", async () => {
      const commands = createStatefulRuntimeCommandExecutor();
      const spec = buildSpec();
      const buildArgs = [
        "build",
        ...runtimeCase.loadArgs,
        "--no-cache",
        "--build-arg",
        "HOST_UID=1000",
        "--secret",
        "id=GITHUB_TOKEN,env=GITHUB_TOKEN",
        "--label",
        "sandbox.managed=true",
        "-t",
        spec.tag,
        "-f",
        spec.dockerfilePath,
        spec.contextDirectory,
      ];
      commands.givenOutput(
        { command: runtimeCase.binary, args: buildArgs },
        "",
      );
      commands.givenOutput(
        {
          command: runtimeCase.binary,
          args: ["image", "inspect", spec.tag],
        },
        imageJson({
          id: "sha256:built",
          references: [spec.tag],
          labels: spec.labels,
        }),
      );
      const service = runtimeCase.create(commands.executor);

      const { result, output } = await runWithLogger(() =>
        service.images.build(spec),
      );

      expect(result.id).toBe("sha256:built");
      expect(commands.events()[0]?.options).toEqual({
        env: runtimeCase.buildEnvironment,
        interactive: false,
      });
      expect(buildArgs).not.toContain("ghp_secret");
      expect(output).not.toContain("ghp_secret");
    });

    test("preserves the child exit code when a build fails", async () => {
      const commands = createStatefulRuntimeCommandExecutor();
      const spec = buildSpec();
      const failure = new ExecError("build failed", 37);
      commands.givenFailure(
        {
          command: runtimeCase.binary,
          args: [
            "build",
            ...runtimeCase.loadArgs,
            "--no-cache",
            "--build-arg",
            "HOST_UID=1000",
            "--secret",
            "id=GITHUB_TOKEN,env=GITHUB_TOKEN",
            "--label",
            "sandbox.managed=true",
            "-t",
            spec.tag,
            "-f",
            spec.dockerfilePath,
            spec.contextDirectory,
          ],
        },
        failure,
      );

      await expect(
        runWithLogger(() =>
          runtimeCase.create(commands.executor).images.build(spec),
        ),
      ).rejects.toBe(failure);
      expect(failure.exitCode).toBe(37);
    });

    test("removes only untagged, managed, unused candidates", async () => {
      const commands = createStatefulRuntimeCommandExecutor();
      const candidates = ["missing", "unmanaged", "tagged", "used", "remove"];
      commands.givenFailure(
        {
          command: runtimeCase.binary,
          args: ["image", "inspect", "missing"],
        },
        new ExecError("No such image", 1, { stderr: "No such image" }),
      );
      for (const candidate of candidates.slice(1)) {
        commands.givenOutput(
          {
            command: runtimeCase.binary,
            args: ["image", "inspect", candidate],
          },
          imageJson({
            id: candidate,
            references: candidate === "tagged" ? ["active:latest"] : [],
            labels:
              candidate === "unmanaged" ? {} : { "sandbox.managed": "true" },
            size: candidate === "remove" ? 2_500 : 100,
          }),
        );
      }
      commands.givenOutput(
        {
          command: runtimeCase.binary,
          args: [
            "ps",
            "-a",
            "--filter",
            "ancestor=used",
            "--format",
            "{{.ID}}",
          ],
        },
        "container-1\n",
      );
      commands.givenOutput(
        {
          command: runtimeCase.binary,
          args: [
            "ps",
            "-a",
            "--filter",
            "ancestor=remove",
            "--format",
            "{{.ID}}",
          ],
        },
        "",
      );
      commands.givenOutput(
        { command: runtimeCase.binary, args: ["rmi", "remove"] },
        "",
      );

      await expect(
        runtimeCase.create(commands.executor).images.removeUnused({
          candidates,
          managedLabel: { key: "sandbox.managed", value: "true" },
        }),
      ).resolves.toEqual({
        removed: [{ id: "remove", estimatedReclaimedBytes: 2_500 }],
        skipped: [
          { id: "missing", reason: "missing" },
          { id: "unmanaged", reason: "unmanaged" },
          { id: "tagged", reason: "tagged" },
          { id: "used", reason: "in-use" },
        ],
        estimatedReclaimedBytes: 2_500,
      });
      expect(
        commands.events().some((event) => event.args.includes("prune")),
      ).toBe(false);
    });

    test("preserves uncertain usage and removal failures", async () => {
      const inspection = imageJson({
        id: "candidate",
        references: [],
        labels: { "sandbox.managed": "true" },
      });
      const usageFailure = createStatefulRuntimeCommandExecutor();
      usageFailure.givenOutput(
        {
          command: runtimeCase.binary,
          args: ["image", "inspect", "candidate"],
        },
        inspection,
      );
      const unavailable = new ExecError("runtime unavailable", 125);
      usageFailure.givenFailure(
        {
          command: runtimeCase.binary,
          args: [
            "ps",
            "-a",
            "--filter",
            "ancestor=candidate",
            "--format",
            "{{.ID}}",
          ],
        },
        unavailable,
      );
      await expect(
        runtimeCase.create(usageFailure.executor).images.removeUnused({
          candidates: ["candidate"],
          managedLabel: { key: "sandbox.managed", value: "true" },
        }),
      ).rejects.toBe(unavailable);

      const removalFailure = createStatefulRuntimeCommandExecutor();
      removalFailure.givenOutput(
        {
          command: runtimeCase.binary,
          args: ["image", "inspect", "candidate"],
        },
        inspection,
      );
      removalFailure.givenOutput(
        {
          command: runtimeCase.binary,
          args: [
            "ps",
            "-a",
            "--filter",
            "ancestor=candidate",
            "--format",
            "{{.ID}}",
          ],
        },
        "",
      );
      const conflict = new ExecError("image became tagged", 1);
      removalFailure.givenFailure(
        { command: runtimeCase.binary, args: ["rmi", "candidate"] },
        conflict,
      );
      await expect(
        runtimeCase.create(removalFailure.executor).images.removeUnused({
          candidates: ["candidate"],
          managedLabel: { key: "sandbox.managed", value: "true" },
        }),
      ).rejects.toBe(conflict);
    });
  });
}
