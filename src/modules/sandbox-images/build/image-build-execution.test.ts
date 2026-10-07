import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { readState, writeState } from "#platform/state/index.js";
import { generateProjectSlug } from "#shared/text/index.js";
import { runInHostTestScope } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { getDockerBuildContextDirectory } from "../sandbox-image-paths.js";
import { getImageHash } from "./build-context-hashing.js";
import { getFinalImage } from "./final-image-selection.js";
import { buildImages } from "./image-build-execution.js";
import {
  getImageNamesToInspect,
  planLayerBuilds,
} from "./image-build-planning.js";

function combineHash(localHash: string, parentHash?: string): string {
  if (!parentHash) return localHash;
  const hash = crypto.createHash("sha256");
  hash.update(localHash);
  hash.update(parentHash);
  return hash.digest("hex").substring(0, 12);
}

function getBaseDockerfilePath(): string {
  return path.join(getDockerBuildContextDirectory(), "Dockerfile");
}

function getProjectImage(projectRoot: string): string {
  return `sandbox-${generateProjectSlug(projectRoot)}:latest`;
}

interface LayeredTestSetup {
  readonly root: string;
  readonly projectRoot: string;
  readonly userDockerfile: string;
  readonly projectDockerfile: string;
}

function createLayeredTestSetup(): LayeredTestSetup {
  const root = createTestDir("image-build");
  const projectRoot = path.join(root, "project");
  const userDockerDir = path.join(root, "config", "docker");
  const projectDockerDir = path.join(projectRoot, ".sandbox", "docker");
  fs.mkdirSync(userDockerDir, { recursive: true });
  fs.mkdirSync(projectDockerDir, { recursive: true });
  const userDockerfile = path.join(userDockerDir, "Dockerfile");
  const projectDockerfile = path.join(projectDockerDir, "Dockerfile");
  fs.writeFileSync(
    userDockerfile,
    "FROM sandbox-base:latest\nRUN echo user-layer",
  );
  fs.writeFileSync(
    projectDockerfile,
    "FROM sandbox-user:latest\nRUN echo project-layer",
  );
  return { root, projectRoot, userDockerfile, projectDockerfile };
}

async function runLayered<T>(
  setup: LayeredTestSetup,
  callback: () => Promise<T>,
  variables?: Readonly<Record<string, string>>,
): Promise<T> {
  return (await runInHostTestScope({ root: setup.root, variables }, callback))
    .result;
}

function givenLayerImages(
  harness: ReturnType<typeof createStatefulContainerRuntimeHarness>,
  setup: LayeredTestSetup,
  labels: {
    readonly base: string | null;
    readonly user: string | null;
    readonly project: string | null;
  },
): void {
  harness.images.create({
    references: ["sandbox-base:latest"],
    ...(labels.base ? { labels: { "dockerfile.hash": labels.base } } : {}),
  });
  harness.images.create({
    references: ["sandbox-user:latest"],
    ...(labels.user ? { labels: { "dockerfile.hash": labels.user } } : {}),
  });
  harness.images.create({
    references: [getProjectImage(setup.projectRoot)],
    ...(labels.project
      ? { labels: { "dockerfile.hash": labels.project } }
      : {}),
  });
}

describe("buildImages", () => {
  test("uses explicit scoped host IDs and records build inputs", async () => {
    const setup = createLayeredTestSetup();
    const harness = createStatefulContainerRuntimeHarness();
    const runtime = await harness.provider.resolve();
    try {
      await runLayered(
        setup,
        () =>
          buildImages(runtime, {
            projectRoot: setup.projectRoot,
            targetLayer: "base",
            buildTrigger: "always",
            cacheStrategy: "native",
          }),
        { SANDBOX_HOST_UID: "1000", SANDBOX_HOST_GID: "1001" },
      );

      expect(harness.images.builds()[0]?.options.buildArguments).toMatchObject({
        HOST_UID: "1000",
        HOST_GID: "1001",
      });
    } finally {
      cleanupTestDir(setup.root);
    }
  });

  test("rebuilds the base image when host ownership changes", async () => {
    using cleanup = new DisposableStack();
    const setup = createLayeredTestSetup();
    cleanup.defer(() => cleanupTestDir(setup.root));
    const harness = createStatefulContainerRuntimeHarness();
    const runtime = await harness.provider.resolve();

    await runLayered(
      setup,
      () =>
        buildImages(runtime, {
          projectRoot: setup.projectRoot,
          targetLayer: "base",
          buildTrigger: "if-needed",
        }),
      { SANDBOX_HOST_UID: "1000", SANDBOX_HOST_GID: "1000" },
    );
    const initialBuildCount = harness.images.builds().length;

    await runLayered(
      setup,
      () =>
        buildImages(runtime, {
          projectRoot: setup.projectRoot,
          targetLayer: "base",
          buildTrigger: "if-needed",
        }),
      { SANDBOX_HOST_UID: "2000", SANDBOX_HOST_GID: "2000" },
    );

    const ownershipRebuilds = harness.images.builds().slice(initialBuildCount);
    expect(ownershipRebuilds.map((build) => build.options.tag)).toEqual([
      "sandbox-base:latest",
      "sandbox-user:latest",
      getProjectImage(setup.projectRoot),
    ]);
    expect(ownershipRebuilds[0]?.options.buildArguments).toMatchObject({
      HOST_UID: "2000",
      HOST_GID: "2000",
    });
  });

  test.each([
    { runtimeName: "docker", availableAncestors: false, projectChanged: false },
    { runtimeName: "podman", availableAncestors: false, projectChanged: false },
    {
      runtimeName: "apple-container",
      availableAncestors: false,
      projectChanged: false,
    },
    {
      runtimeName: "apple-container",
      availableAncestors: true,
      projectChanged: false,
    },
    {
      runtimeName: "apple-container",
      availableAncestors: false,
      projectChanged: true,
    },
  ] as const)(
    "recovers missing images despite complete cached records: %j",
    async ({ runtimeName, availableAncestors, projectChanged }) => {
      using cleanup = new DisposableStack();
      const setup = createLayeredTestSetup();
      cleanup.defer(() => cleanupTestDir(setup.root));
      const harness = createStatefulContainerRuntimeHarness({
        runtime: runtimeName,
      });
      const runtime = await harness.provider.resolve();
      const baseHash = getImageHash(getBaseDockerfilePath());
      const userHash = combineHash(
        getImageHash(setup.userDockerfile),
        baseHash,
      );
      const projectHash = combineHash(
        getImageHash(setup.projectDockerfile),
        userHash,
      );

      if (availableAncestors) {
        harness.images.create({
          id: "sha256:abc001",
          references: ["sandbox-base:latest"],
          labels: { "dockerfile.hash": baseHash, "sandbox.managed": "true" },
        });
        harness.images.create({
          id: "sha256:abc002",
          references: ["sandbox-user:latest"],
          labels: { "dockerfile.hash": userHash, "sandbox.managed": "true" },
        });
      }
      if (projectChanged) {
        fs.appendFileSync(
          setup.projectDockerfile,
          "\nRUN echo changed-project",
        );
      }

      const result = await runLayered(setup, async () => {
        writeState({
          sandboxImages: {
            [`${runtimeName}:sandbox-base:latest`]: {
              reference: "sandbox-base:latest",
              digest: "sha256:abc001",
              labels: { "dockerfile.hash": baseHash },
            },
            [`${runtimeName}:sandbox-user:latest`]: {
              reference: "sandbox-user:latest",
              digest: "sha256:abc002",
              labels: { "dockerfile.hash": userHash },
            },
            [`${runtimeName}:${getProjectImage(setup.projectRoot)}`]: {
              reference: getProjectImage(setup.projectRoot),
              digest: "sha256:abc003",
              labels: { "dockerfile.hash": projectHash },
            },
          },
        });
        return buildImages(runtime, {
          projectRoot: setup.projectRoot,
          buildTrigger: "if-needed",
        });
      });

      const expectedBuilds = availableAncestors
        ? [getProjectImage(setup.projectRoot)]
        : [
            "sandbox-base:latest",
            "sandbox-user:latest",
            getProjectImage(setup.projectRoot),
          ];
      expect(harness.images.builds().map((build) => build.options.tag)).toEqual(
        expectedBuilds,
      );
      expect(
        harness.images.find(getProjectImage(setup.projectRoot)),
      ).toMatchObject({
        id: result.image.digest,
      });
    },
  );

  test("preserves the recorded image reference and digest for a no-op build", async () => {
    using cleanup = new DisposableStack();
    const setup = createLayeredTestSetup();
    cleanup.defer(() => cleanupTestDir(setup.root));
    const harness = createStatefulContainerRuntimeHarness({
      runtime: "apple-container",
    });
    const runtime = await harness.provider.resolve();
    const baseHash = getImageHash(getBaseDockerfilePath());
    const userHash = combineHash(getImageHash(setup.userDockerfile), baseHash);
    const projectHash = combineHash(
      getImageHash(setup.projectDockerfile),
      userHash,
    );
    const finalImage = {
      reference: `${getProjectImage(setup.projectRoot)}@sha256:abcdef`,
      digest: "sha256:abcdef",
    };

    harness.images.create({
      id: finalImage.digest,
      references: [finalImage.reference],
      labels: { "dockerfile.hash": projectHash },
    });
    const result = await runLayered(setup, async () => {
      writeState({
        sandboxImages: {
          "apple-container:sandbox-base:latest": {
            reference: "sandbox-base:latest@sha256:abc001",
            digest: "sha256:abc001",
            labels: { "dockerfile.hash": baseHash },
          },
          "apple-container:sandbox-user:latest": {
            reference: "sandbox-user:latest@sha256:abc002",
            digest: "sha256:abc002",
            labels: { "dockerfile.hash": userHash },
          },
          [`apple-container:${getProjectImage(setup.projectRoot)}`]: {
            ...finalImage,
            labels: { "dockerfile.hash": projectHash },
          },
        },
      });
      return buildImages(runtime, {
        projectRoot: setup.projectRoot,
        buildTrigger: "if-needed",
      });
    });

    expect(harness.images.builds()).toHaveLength(0);
    expect(result.image).toEqual(finalImage);
    expect(harness.events()).toEqual([
      { type: "image.inspect", reference: finalImage.reference },
    ]);
  });

  test("persists replaced image ownership across cleanup workflow runs", async () => {
    using cleanup = new DisposableStack();
    const setup = createLayeredTestSetup();
    cleanup.defer(() => cleanupTestDir(setup.root));
    const harness = createStatefulContainerRuntimeHarness();
    harness.images.create({
      id: "sha256:replaced-base",
      references: ["sandbox-base:latest"],
      labels: { "sandbox.managed": "true" },
    });
    harness.instances.create({
      name: "old-image-consumer",
      image: "sha256:replaced-base",
      labels: {},
      status: "running",
    });
    const runtime = await harness.provider.resolve();

    const state = await runLayered(setup, async () => {
      writeState({
        sandboxImages: {
          "docker:sandbox-base:latest": {
            reference: "sandbox-base:latest",
            digest: "sha256:replaced-base",
          },
        },
      });
      await buildImages(runtime, {
        projectRoot: setup.projectRoot,
        targetLayer: "base",
        buildTrigger: "always",
      });
      return readState();
    });

    expect(
      state.sandboxImages?.["docker:sandbox-base:latest"]?.ownedDigests,
    ).toContain("sha256:replaced-base");
    const cleanupEvents = harness
      .events()
      .filter((event) => event.type === "image.cleanup");
    expect(cleanupEvents.at(-1)?.request.candidates).toContain(
      "sha256:replaced-base",
    );
  });

  test("preserves build failure exit codes without process exit", async () => {
    const setup = createLayeredTestSetup();
    const harness = createStatefulContainerRuntimeHarness();
    harness.images.givenNextBuild({
      error: Object.assign(new Error("Command failed with exit code 127"), {
        exitCode: 127,
      }),
    });
    const runtime = await harness.provider.resolve();
    try {
      await expect(
        runLayered(setup, () =>
          buildImages(runtime, {
            projectRoot: setup.projectRoot,
            targetLayer: "base",
            buildTrigger: "always",
          }),
        ),
      ).rejects.toMatchObject({
        message:
          "Failed to build sandbox-base:latest\nCommand failed with exit code 127",
        exitCode: 127,
      });
    } finally {
      cleanupTestDir(setup.root);
    }
  });

  test("rebuilds descendants with parent-derived labels after a base change", async () => {
    const setup = createLayeredTestSetup();
    const harness = createStatefulContainerRuntimeHarness();
    const staleBaseHash = "aaaaaaaaaaaa";
    const userHash = getImageHash(setup.userDockerfile);
    const projectHash = getImageHash(setup.projectDockerfile);
    const staleUserHash = combineHash(userHash, staleBaseHash);
    givenLayerImages(harness, setup, {
      base: staleBaseHash,
      user: staleUserHash,
      project: combineHash(projectHash, staleUserHash),
    });
    const runtime = await harness.provider.resolve();
    try {
      await runLayered(setup, () =>
        buildImages(runtime, {
          projectRoot: setup.projectRoot,
          buildTrigger: "if-needed",
          cacheStrategy: "native",
        }),
      );

      const baseHash = getImageHash(getBaseDockerfilePath());
      const expectedUserHash = combineHash(userHash, baseHash);
      expect(harness.images.builds().map((build) => build.options.tag)).toEqual(
        [
          "sandbox-base:latest",
          "sandbox-user:latest",
          getProjectImage(setup.projectRoot),
        ],
      );
      expect(
        harness.images.find("sandbox-user:latest")?.labels["dockerfile.hash"],
      ).toBe(expectedUserHash);
      expect(
        harness.images.find(getProjectImage(setup.projectRoot))?.labels[
          "dockerfile.hash"
        ],
      ).toBe(combineHash(projectHash, expectedUserHash));
      expect(
        harness.images
          .builds()
          .every((build) => build.options.cachePolicy === "use"),
      ).toBe(true);
    } finally {
      cleanupTestDir(setup.root);
    }
  });

  test("forces no-cache for every selected layer", async () => {
    const setup = createLayeredTestSetup();
    const harness = createStatefulContainerRuntimeHarness();
    givenLayerImages(harness, setup, {
      base: getImageHash(getBaseDockerfilePath()),
      user: getImageHash(setup.userDockerfile),
      project: getImageHash(setup.projectDockerfile),
    });
    const runtime = await harness.provider.resolve();
    try {
      await runLayered(setup, () =>
        buildImages(runtime, {
          projectRoot: setup.projectRoot,
          buildTrigger: "always",
          cacheStrategy: "none",
        }),
      );
      expect(harness.images.builds()).toHaveLength(3);
      expect(
        harness.images
          .builds()
          .every((build) => build.options.cachePolicy === "bypass"),
      ).toBe(true);
    } finally {
      cleanupTestDir(setup.root);
    }
  });

  test("treats missing labels as stale and refreshes target ancestors", async () => {
    const setup = createLayeredTestSetup();
    const harness = createStatefulContainerRuntimeHarness();
    givenLayerImages(harness, setup, {
      base: "dddddddddddd",
      user: null,
      project: "not-a-hash",
    });
    const runtime = await harness.provider.resolve();
    try {
      const plan = await runLayered(setup, () =>
        planLayerBuilds(runtime.runtime, {
          projectRoot: setup.projectRoot,
          targetLayer: "project",
          buildTrigger: "if-needed",
        }),
      );
      expect(plan.layers.every((entry) => entry.state.shouldBuild)).toBe(true);

      await runLayered(setup, () =>
        buildImages(runtime, {
          projectRoot: setup.projectRoot,
          targetLayer: "project",
          buildTrigger: "if-needed",
        }),
      );
      expect(harness.images.builds().map((build) => build.options.tag)).toEqual(
        [
          "sandbox-base:latest",
          "sandbox-user:latest",
          getProjectImage(setup.projectRoot),
        ],
      );
    } finally {
      cleanupTestDir(setup.root);
    }
  });
});

describe("image selection", () => {
  test("resolves project image names and prerequisite inspection", async () => {
    const setup = createLayeredTestSetup();
    try {
      const image = await runLayered(setup, () =>
        Promise.resolve(getFinalImage(setup.projectRoot)),
      );
      expect(image).toMatch(/^sandbox-[a-z0-9-]+:latest$/);
      expect(image).not.toMatch(/-[a-f0-9]{12}:/);

      const names = await runLayered(setup, () =>
        Promise.resolve(
          getImageNamesToInspect(
            path.join(setup.root, "config"),
            setup.projectRoot,
            "project",
          ),
        ),
      );
      expect(names).toContain("sandbox-base:latest");
      expect(names).toContain("sandbox-user:latest");
      expect(names).toContain(image);
    } finally {
      cleanupTestDir(setup.root);
    }
  });
});
