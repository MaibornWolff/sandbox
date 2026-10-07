import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTestClock } from "#platform/clock/__test__/index.js";
import { removeOwnedDirectory } from "#platform/filesystem/index.js";
import { ExecError } from "#platform/process/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { createStatefulRuntimeCommandExecutor } from "../__test__/index.js";
import type { ContainerSpec } from "../container-contract.js";
import type { RuntimeExecutor } from "../executor.js";
import { createAppleContainerOperations } from "./containers.js";
import type { AppleNetworkOperations } from "./networking.js";
import {
  createAppleVolumeOperations,
  initializeAppleVolumeMounts,
} from "./volumes.js";

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

function volumeRoot(homeDirectory: string): string {
  return path.join(
    homeDirectory,
    ".local",
    "share",
    "sandbox",
    "apple-container-volumes",
  );
}

function createVolumes(
  commands: ReturnType<typeof createStatefulRuntimeCommandExecutor>,
  homeDirectory: string,
) {
  const getRoot = () => volumeRoot(homeDirectory);
  const containers = createAppleContainerOperations({
    exec: commands.executor,
    networking: readyNetwork,
    getVolumeRoot: getRoot,
    resolveMountSource: (mount) =>
      mount.type === "bind" ? mount.sourcePath : mount.volumeName,
  });
  return createAppleVolumeOperations({ getRoot, containers });
}

function seedSpec(names: readonly string[]): ContainerSpec {
  return {
    name: "sandbox-seed-test",
    image: "sandbox-image:latest",
    labels: {},
    environment: {},
    mounts: names.map((volumeName) => ({
      type: "volume",
      volumeName,
      targetPath: `/${volumeName}`,
      readOnly: false,
    })),
    ports: [],
    init: false,
    removeOnExit: true,
    resources: {},
    security: { capabilities: [], dockerInDocker: false },
  };
}

function seedImageFiles(args: readonly string[]): void {
  for (const value of args) {
    const directory = /^(.*):\/run\/sandbox-volume-seed\/\d+:rw$/u.exec(
      value,
    )?.[1];
    if (!directory) continue;
    const nested = path.join(directory, "readonly");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "image-file"), "from-image", {
      mode: 0o444,
    });
    fs.chmodSync(nested, 0o555);
  }
}

describe("Apple logical volume initialization", () => {
  test("seeds empty volumes together once and preserves existing user data", async () => {
    const root = createTestDir("apple-volume-seed");
    using cleanup = new DisposableStack();
    cleanup.defer(() => removeOwnedDirectory(root));
    fs.mkdirSync(path.join(root, "existing"));
    fs.mkdirSync(path.join(root, "empty-existing"));
    fs.writeFileSync(path.join(root, "existing", "user-file"), "user-data");
    let helperCalls = 0;
    const exec: RuntimeExecutor = async (_command, args = []) => {
      helperCalls += 1;
      seedImageFiles(args);
      return "";
    };
    await runWithTestLogger(async () => {
      const spec = seedSpec([
        "first",
        "second",
        "existing",
        "empty-existing",
        "first",
      ]);
      await initializeAppleVolumeMounts({ volumeRoot: root, spec, exec });
      expect(
        fs.readFileSync(
          path.join(root, "first", "readonly", "image-file"),
          "utf8",
        ),
      ).toBe("from-image");
      expect(
        fs.readFileSync(
          path.join(root, "second", "readonly", "image-file"),
          "utf8",
        ),
      ).toBe("from-image");
      expect(
        fs.readFileSync(path.join(root, "existing", "user-file"), "utf8"),
      ).toBe("user-data");
      await initializeAppleVolumeMounts({
        volumeRoot: root,
        spec: { ...spec, image: "new-image:latest" },
        exec,
      });
      expect(helperCalls).toBe(1);
      expect(fs.readdirSync(path.join(root, "empty-existing"))).toEqual([]);
      expect(
        fs.readdirSync(root).some((name) => name.startsWith(".volume-seed-")),
      ).toBe(false);
    });
  });

  test("keeps failed copies invisible, removes staging, and permits retry", async () => {
    const root = createTestDir("apple-volume-seed-failure");
    using cleanup = new DisposableStack();
    cleanup.defer(() => removeOwnedDirectory(root));
    let fail = true;
    const failure = new ExecError("image copy failed", 23);
    const exec: RuntimeExecutor = async (_command, args = []) => {
      seedImageFiles(args);
      if (fail) throw failure;
      return "";
    };
    await runWithTestLogger(async () => {
      const spec = seedSpec(["cache"]);
      await expect(
        initializeAppleVolumeMounts({ volumeRoot: root, spec, exec }),
      ).rejects.toBe(failure);
      expect(fs.readdirSync(path.join(root, "cache"))).toEqual([]);
      expect(
        fs.readdirSync(root).filter((name) => name.startsWith(".volume-")),
      ).toEqual([]);
      fail = false;
      await initializeAppleVolumeMounts({ volumeRoot: root, spec, exec });
      expect(
        fs.readFileSync(
          path.join(root, "cache", "readonly", "image-file"),
          "utf8",
        ),
      ).toBe("from-image");
    });
  });

  test("serializes concurrent initialization without copying the same volume twice", async () => {
    const root = createTestDir("apple-volume-seed-concurrent");
    using cleanup = new DisposableStack();
    cleanup.defer(() => removeOwnedDirectory(root));
    const clock = createTestClock();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let helperCalls = 0;
    const exec: RuntimeExecutor = async (_command, args = []) => {
      helperCalls += 1;
      started.resolve();
      await release.promise;
      seedImageFiles(args);
      return "";
    };
    await runWithTestLogger(
      async () => {
        const spec = seedSpec(["cache"]);
        const first = initializeAppleVolumeMounts({
          volumeRoot: root,
          spec,
          exec,
        });
        await started.promise;
        const second = initializeAppleVolumeMounts({
          volumeRoot: root,
          spec,
          exec,
        });
        await clock.waitForSleep();
        release.resolve();
        await first;
        await clock.advanceBy(100);
        await second;
        expect(helperCalls).toBe(1);
        expect(
          fs.readFileSync(
            path.join(root, "cache", "readonly", "image-file"),
            "utf8",
          ),
        ).toBe("from-image");
      },
      { clock: clock.clock },
    );
  });
});

describe("Apple logical volume operations", () => {
  test("creates persistent host directories and preserves their contents", async () => {
    const root = createTestDir("apple-volume-persistence");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    const commands = createStatefulRuntimeCommandExecutor();

    await runWithTestLogger(
      async () => {
        const volumes = createVolumes(commands, root);
        await expect(volumes.exists("source")).resolves.toBe(false);
        await volumes.create("source");

        const source = path.join(volumeRoot(root), "source");
        const nested = path.join(source, "nested");
        fs.mkdirSync(nested);
        const sourceFile = path.join(nested, "data");
        fs.writeFileSync(sourceFile, "persistent-data");
        const nextVolumes = createVolumes(commands, root);
        await expect(nextVolumes.exists("source")).resolves.toBe(true);
        await nextVolumes.create("source");
        expect(fs.readFileSync(sourceFile, "utf8")).toBe("persistent-data");
      },
      { homeDirectory: root, platform: "darwin" },
    );
  });

  test("reports missing volume and invalid-name failures", async () => {
    const root = createTestDir("apple-volume-failures");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    const commands = createStatefulRuntimeCommandExecutor();

    await runWithTestLogger(
      async () => {
        const volumes = createVolumes(commands, root);
        await expect(volumes.remove({ name: "missing" })).rejects.toThrow(
          "Volume not found: missing",
        );
        await expect(volumes.create("../escape")).rejects.toThrow(
          "Invalid Apple container volume name",
        );
      },
      { homeDirectory: root, platform: "darwin" },
    );
  });

  test.each([
    ["running", ""],
    ["stopped", ""],
    ["running", "nested"],
    ["stopped", "nested/deeper"],
  ])(
    "blocks removal when a %s container references volume path %s",
    async (state, subdirectory) => {
      const root = createTestDir(`apple-volume-${state}`);
      using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
      const commands = createStatefulRuntimeCommandExecutor();
      const source = path.join(volumeRoot(root), "cache");
      const container = {
        id: `${state}-consumer`,
        configuration: {
          id: `${state}-consumer`,
          image: {
            descriptor: { digest: "sha256:image" },
            reference: "sandbox:latest",
          },
          mounts: [
            {
              source: path.join(source, subdirectory),
              destination: "/var/cache",
              options: ["rw"],
              type: { virtiofs: {} },
            },
          ],
        },
        status: { state },
      };
      commands.givenOutput(
        { command: "container", args: ["list", "-a", "--format", "json"] },
        JSON.stringify([container]),
      );
      commands.givenOutput(
        { command: "container", args: ["inspect", `${state}-consumer`] },
        JSON.stringify([container]),
      );

      await runWithTestLogger(
        async () => {
          const volumes = createVolumes(commands, root);
          await volumes.create("cache");
          fs.writeFileSync(path.join(source, "data"), "keep");

          await expect(volumes.remove({ name: "cache" })).rejects.toThrow(
            `referenced by container ${state}-consumer`,
          );
          expect(fs.readFileSync(path.join(source, "data"), "utf8")).toBe(
            "keep",
          );
        },
        { homeDirectory: root, platform: "darwin" },
      );
    },
  );

  test("preserves container query and inspection failures during removal", async () => {
    const root = createTestDir("apple-volume-runtime-failure");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    const queryFailure = new ExecError("service unavailable", 125);
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenFailure(
      { command: "container", args: ["list", "-a", "--format", "json"] },
      queryFailure,
    );

    await runWithTestLogger(
      async () => {
        const volumes = createVolumes(commands, root);
        await volumes.create("cache");
        await expect(volumes.remove({ name: "cache" })).rejects.toBe(
          queryFailure,
        );
        expect(await volumes.exists("cache")).toBe(true);
      },
      { homeDirectory: root, platform: "darwin" },
    );
  });

  test("removes an unreferenced volume after exact inspection", async () => {
    const root = createTestDir("apple-volume-remove");
    using _cleanup = { [Symbol.dispose]: () => cleanupTestDir(root) };
    const commands = createStatefulRuntimeCommandExecutor();
    commands.givenOutput(
      { command: "container", args: ["list", "-a", "--format", "json"] },
      "[]",
    );

    await runWithTestLogger(
      async () => {
        const volumes = createVolumes(commands, root);
        await volumes.create("cache");
        await volumes.remove({ name: "cache" });
        await expect(volumes.exists("cache")).resolves.toBe(false);
      },
      { homeDirectory: root, platform: "darwin" },
    );
  });
});
