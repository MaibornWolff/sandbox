import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  autoMigrateLegacyResources,
  runFullMigration,
} from "./legacy-resource-migration.js";

let testDir: string;

beforeEach(() => {
  testDir = createTestDir("migrate");
});

afterEach(() => {
  cleanupTestDir(testDir);
});

async function runScoped<T>(callback: () => Promise<T>): Promise<T> {
  return (await runInHostTestScope({ root: testDir }, callback)).result;
}

describe("runFullMigration", () => {
  test("retags legacy images and preserves image identity", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.images.create({
      id: "sha256:legacy",
      references: ["sandbox--base:latest", "unrelated:latest"],
    });
    const runtime = await harness.provider.resolve();

    const result = await runScoped(() => runFullMigration(runtime, testDir));

    expect(result.imagesRetagged).toBe(1);
    expect(harness.images.find("sandbox-base:latest")?.id).toBe(
      "sha256:legacy",
    );
    expect(harness.images.find("sandbox--base:latest")).toBeUndefined();
    expect(harness.images.find("unrelated:latest")).toBeDefined();
  });

  test("copies and removes the legacy cache volume", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    harness.volumes.create({
      name: "sandbox--cache",
      files: { "cache/file": "content" },
    });
    const runtime = await harness.provider.resolve();

    const result = await runScoped(() => runFullMigration(runtime, testDir));

    expect(result.volumeMigrated).toBe(true);
    expect(harness.volumes.find("sandbox-cache")?.files).toEqual({
      "cache/file": "content",
    });
    expect(harness.volumes.find("sandbox--cache")).toBeUndefined();
  });

  test("removes only legacy containers", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const legacy = harness.containers.create({
      name: "sandbox--myproj-1234",
      image: "sandbox--base:latest",
      labels: {},
      status: "exited",
    });
    const current = harness.containers.create({
      name: "sandbox-other-5678",
      image: "sandbox-base:latest",
      labels: {},
      status: "exited",
    });
    const runtime = await harness.provider.resolve();

    const result = await runScoped(() => runFullMigration(runtime, testDir));

    expect(result.containersRemoved).toBe(1);
    expect(legacy.snapshot().status).toBe("removed");
    expect(current.snapshot().status).toBe("exited");
  });

  test("migrates project Dockerfiles and returns zeros on repeat", async () => {
    const dockerDir = path.join(testDir, ".sandbox", "docker");
    fs.mkdirSync(dockerDir, { recursive: true });
    const dockerfile = path.join(dockerDir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM sandbox--base:latest\n");
    const harness = createStatefulContainerRuntimeHarness();
    const runtime = await harness.provider.resolve();

    const first = await runScoped(() => runFullMigration(runtime, testDir));
    const second = await runScoped(() => runFullMigration(runtime, testDir));

    expect(first.dockerfilesMigrated).toBe(1);
    expect(second).toEqual({
      imagesRetagged: 0,
      volumeMigrated: false,
      containersRemoved: 0,
      dockerfilesMigrated: 0,
    });
    expect(fs.readFileSync(dockerfile, "utf-8")).toBe(
      "FROM sandbox-base:latest\n",
    );
  });

  test("continues migration after partial runtime failures", async () => {
    const dockerDir = path.join(testDir, ".sandbox", "docker");
    fs.mkdirSync(dockerDir, { recursive: true });
    const dockerfile = path.join(dockerDir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM sandbox--base:latest\n");
    const harness = createStatefulContainerRuntimeHarness();
    harness.images.create({ references: ["sandbox--base:latest"] });
    harness.volumes.create({ name: "sandbox--cache" });
    harness.containers.create({
      name: "sandbox--project",
      image: "old",
      labels: {},
      status: "exited",
    });
    harness.system.fail("image.tag", new Error("tag failed"));
    harness.system.fail("volume.copy", new Error("copy failed"));
    harness.system.fail("container.remove", new Error("remove failed"));
    const runtime = await harness.provider.resolve();

    const result = await runScoped(() => runFullMigration(runtime, testDir));

    expect(result).toEqual({
      imagesRetagged: 0,
      volumeMigrated: false,
      containersRemoved: 0,
      dockerfilesMigrated: 1,
    });
    expect(harness.volumes.find("sandbox-cache")).toBeUndefined();
    expect(fs.readFileSync(dockerfile, "utf-8")).toBe(
      "FROM sandbox-base:latest\n",
    );
  });
});

describe("autoMigrateLegacyResources", () => {
  test("runs migration only when a legacy Dockerfile exists", async () => {
    const dockerDir = path.join(testDir, ".sandbox", "docker");
    fs.mkdirSync(dockerDir, { recursive: true });
    const dockerfile = path.join(dockerDir, "Dockerfile");
    fs.writeFileSync(dockerfile, "FROM sandbox--base:latest\n");
    const harness = createStatefulContainerRuntimeHarness();
    const container = harness.containers.create({
      name: "sandbox--proj-1234",
      image: "sandbox--base:latest",
      labels: {},
      status: "exited",
    });
    const runtime = await harness.provider.resolve();

    await runScoped(() => autoMigrateLegacyResources(runtime, testDir));
    expect(fs.readFileSync(dockerfile, "utf-8")).toBe(
      "FROM sandbox-base:latest\n",
    );
    expect(container.snapshot().status).toBe("removed");

    const eventsBefore = harness.events().length;
    await runScoped(() => autoMigrateLegacyResources(runtime, testDir));
    expect(harness.events()).toHaveLength(eventsBefore);
  });
});
