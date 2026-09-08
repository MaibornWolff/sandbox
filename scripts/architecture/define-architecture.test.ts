import { describe, expect, test } from "bun:test";
import type { ArchitectureDefinition } from "./define-architecture.js";
import { validateArchitecture } from "./define-architecture.js";

function definition(
  overrides: Partial<ArchitectureDefinition> = {},
): ArchitectureDefinition {
  return {
    apps: [],
    modules: [
      { name: "consumer", dependencies: ["provider"] },
      { name: "provider", dependencies: [] },
    ],
    platform: [],
    shared: [],
    testApis: [],
    legacyRoots: [],
    ...overrides,
  };
}

describe("validateArchitecture", () => {
  test("accepts a valid declared graph", () => {
    expect(() => validateArchitecture(definition())).not.toThrow();
  });

  test("rejects an unknown dependency", () => {
    const architecture = definition({
      modules: [{ name: "consumer", dependencies: ["missing"] }],
    });
    expect(() => validateArchitecture(architecture)).toThrow(
      "Component consumer has unknown dependency missing",
    );
  });

  test("rejects a self dependency", () => {
    const architecture = definition({
      modules: [{ name: "consumer", dependencies: ["consumer"] }],
    });
    expect(() => validateArchitecture(architecture)).toThrow(
      "Component consumer cannot depend on itself",
    );
  });

  test("rejects a duplicate dependency", () => {
    const architecture = definition({
      modules: [
        { name: "consumer", dependencies: ["provider", "provider"] },
        { name: "provider", dependencies: [] },
      ],
    });
    expect(() => validateArchitecture(architecture)).toThrow(
      "Duplicate consumer dependency: provider",
    );
  });

  test("rejects duplicate component names across groups", () => {
    const architecture = definition({
      platform: [{ name: "provider", dependencies: [] }],
    });
    expect(() => validateArchitecture(architecture)).toThrow(
      "Duplicate component name: provider",
    );
  });

  test("rejects a declared cycle", () => {
    const architecture = definition({
      modules: [
        { name: "consumer", dependencies: ["provider"] },
        { name: "provider", dependencies: ["consumer"] },
      ],
    });
    expect(() => validateArchitecture(architecture)).toThrow(
      "Declared architecture cycle: consumer -> provider -> consumer",
    );
  });

  test("rejects an invalid layer dependency", () => {
    const architecture = definition({
      apps: [{ name: "host", dependencies: [] }],
      platform: [{ name: "adapter", dependencies: ["host"] }],
    });
    expect(() => validateArchitecture(architecture)).toThrow(
      "Component adapter cannot depend on apps component host",
    );
  });

  test("rejects application dependencies on internal platform components", () => {
    const architecture = definition({
      apps: [{ name: "host", dependencies: ["process"] }],
      platform: [{ name: "process", internal: true, dependencies: [] }],
    });
    expect(() => validateArchitecture(architecture)).toThrow(
      "Component host cannot depend on internal platform component process",
    );
  });

  test("rejects a test API without a declared owner", () => {
    expect(() =>
      validateArchitecture(definition({ testApis: ["platform/missing"] })),
    ).toThrow("Test API has unknown owner platform/missing");
  });

  test("rejects duplicate asset root owners", () => {
    const architecture = definition({
      modules: [
        { name: "consumer", dependencies: ["provider"], assets: ["templates"] },
        { name: "provider", dependencies: [], assets: ["templates"] },
      ],
    });
    expect(() => validateArchitecture(architecture)).toThrow(
      "Duplicate asset root owner: templates",
    );
  });
});
