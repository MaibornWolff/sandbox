import { describe, expect, test } from "bun:test";
import type { SandboxInstanceSpec } from "#platform/container-runtime/index.js";
import {
  computeContainerHash,
  computeRuntimeContainerHash,
} from "./container-hashing.js";

function createSpec(
  overrides: Partial<SandboxInstanceSpec> = {},
): SandboxInstanceSpec {
  return {
    name: "sandbox-project",
    image: { reference: "sha256:image", digest: "sha256:image" },
    labels: { "sandbox.project": "project", "sandbox.hash": "excluded" },
    environment: { B: "2", A: "1" },
    mounts: [
      {
        type: "workspace",
        sourcePath: "/host",
        targetPath: "/workspace",
        readOnly: false,
      },
    ],
    ports: [{ hostPort: 3000, instancePort: 3000, protocol: "tcp" }],
    init: true,
    removeOnExit: true,
    resources: { sharedMemorySize: "1g" },
    security: { capabilities: ["NET_ADMIN"], nestedContainerRuntime: false },
    ...overrides,
  };
}

function hash(
  spec: SandboxInstanceSpec,
  overrides: Partial<{
    readonly version: string;
    readonly runtime: "apple-container" | "docker" | "podman";
    readonly runtimeCompatibilityIdentity: string;
    readonly imageIdentity: string;
  }> = {},
) {
  return computeContainerHash({
    version: "1.0.0",
    runtime: "docker",
    runtimeCompatibilityIdentity: "docker",
    imageIdentity: "sha256:image",
    spec,
    ...overrides,
  });
}

describe("computeContainerHash", () => {
  test("is stable for equivalent map order", () => {
    const left = hash(createSpec());
    const right = hash(createSpec({ environment: { A: "1", B: "2" } }));
    expect(left).toBe(right);
  });

  test("excludes generated name and hash label", () => {
    const left = hash(createSpec());
    const right = hash(
      createSpec({
        name: "sandbox-project-2",
        labels: { "sandbox.hash": "different", "sandbox.project": "project" },
      }),
    );
    expect(left).toBe(right);
  });

  test.each([
    ["environment", createSpec({ environment: { A: "changed" } })],
    ["mount", createSpec({ mounts: [] })],
    ["port", createSpec({ ports: [] })],
    ["resource", createSpec({ resources: { sharedMemorySize: "2g" } })],
    [
      "security",
      createSpec({
        security: { capabilities: [], nestedContainerRuntime: false },
      }),
    ],
  ])("changes for a structural %s change", (_name, spec) => {
    expect(hash(spec)).not.toBe(hash(createSpec()));
  });

  test("changes for runtime, compatibility, version, and image identity", () => {
    const spec = createSpec();
    const baseline = hash(spec);
    expect(hash(spec, { runtime: "podman" })).not.toBe(baseline);
    expect(
      hash(spec, { runtimeCompatibilityIdentity: "changed-bridge" }),
    ).not.toBe(baseline);
    expect(hash(spec, { version: "2.0.0" })).not.toBe(baseline);
    expect(hash(spec, { imageIdentity: "sha256:other" })).not.toBe(baseline);
  });

  test("reads a fresh bridge resolver identity without changing image identity", async () => {
    let bridgeResolverIdentity = "bridge-a";
    const service = {
      runtime: "apple-container" as const,
      getCompatibilityIdentity: async () => bridgeResolverIdentity,
    };
    const options = {
      version: "1.0.0",
      service,
      imageIdentity: "sha256:image",
      spec: createSpec(),
    };

    const first = await computeRuntimeContainerHash(options);
    bridgeResolverIdentity = "bridge-b";
    const second = await computeRuntimeContainerHash(options);

    expect(first).not.toBe(second);
    expect(options.imageIdentity).toBe("sha256:image");
    expect(options.spec.image.digest).toBe("sha256:image");
  });

  test("preserves mount order", () => {
    const first = createSpec({
      mounts: [
        {
          type: "workspace",
          sourcePath: "/one",
          targetPath: "/data",
          readOnly: true,
        },
        {
          type: "workspace",
          sourcePath: "/two",
          targetPath: "/data/nested",
          readOnly: false,
        },
      ],
    });
    expect(hash(first)).not.toBe(
      hash({ ...first, mounts: [...first.mounts].reverse() }),
    );
  });
});
