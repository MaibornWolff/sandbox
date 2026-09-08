import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import {
  computeContainerHash,
  getContainerHash,
  getImageId,
  SANDBOX_HASH_LABEL,
} from "./container-hashing.js";

describe("computeContainerHash", () => {
  test("returns a deterministic 12-character hexadecimal identity", () => {
    const args = ["--label", "sandbox.project=test", "-v", "/a:/a:rw"];
    const first = computeContainerHash("1.0.0", "sha256:abc", args);
    const second = computeContainerHash("1.0.0", "sha256:abc", args);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(second).toBe(first);
  });

  test("changes for version, image, argument value, or argument order", () => {
    const baseline = computeContainerHash("1.0.0", "sha256:abc", ["-v", "/a"]);
    expect(computeContainerHash("1.1.0", "sha256:abc", ["-v", "/a"])).not.toBe(
      baseline,
    );
    expect(computeContainerHash("1.0.0", "sha256:def", ["-v", "/a"])).not.toBe(
      baseline,
    );
    expect(computeContainerHash("1.0.0", "sha256:abc", ["-v", "/b"])).not.toBe(
      baseline,
    );
    expect(computeContainerHash("1.0.0", "sha256:abc", ["/a", "-v"])).not.toBe(
      baseline,
    );
  });

  test("uses separators to avoid concatenation collisions and handles empty args", () => {
    expect(computeContainerHash("ab", "cd", [])).not.toBe(
      computeContainerHash("a", "bcd", []),
    );
    expect(computeContainerHash("1", "sha256:a", [])).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("managed runtime identities", () => {
  test("reads Docker and Podman image IDs from managed image state", async () => {
    for (const runtimeName of ["docker", "podman"] as const) {
      const runtime = createStatefulContainerRuntimeHarness({
        runtime: runtimeName,
      });
      runtime.images.create({
        id: `sha256:${runtimeName}`,
        references: ["sandbox-base:latest"],
      });
      const service = await runtime.provider.resolve();
      expect(await getImageId(service, "sandbox-base:latest")).toBe(
        `sha256:${runtimeName}`,
      );
      expect(runtime.events()).toContainEqual({
        type: "image.id",
        reference: "sandbox-base:latest",
      });
    }
  });

  test("reads present, absent, and missing container hash labels", async () => {
    const runtime = createStatefulContainerRuntimeHarness();
    const labelled = runtime.containers.create({
      name: "labelled",
      image: "sandbox-base:latest",
      labels: { [SANDBOX_HASH_LABEL]: "abc123def456" },
      status: "running",
    });
    const unlabelled = runtime.containers.create({
      name: "unlabelled",
      image: "sandbox-base:latest",
      labels: {},
      status: "running",
    });
    const service = await runtime.provider.resolve();

    expect(await getContainerHash(service, labelled.id)).toBe("abc123def456");
    expect(await getContainerHash(service, unlabelled.id)).toBeNull();
    expect(await getContainerHash(service, "missing")).toBeNull();
  });
});
