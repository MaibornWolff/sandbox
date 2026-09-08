import { describe, expect, test } from "bun:test";
import type {
  IForbiddenRuleType,
  IRegularForbiddenRuleType,
} from "dependency-cruiser";
import { buildRules } from "./build-rules.js";
import type { ArchitectureDefinition } from "./define-architecture.js";

const architecture: ArchitectureDefinition = {
  apps: [],
  modules: [
    {
      name: "consumer",
      dependencies: ["provider"],
      testDependencies: ["test-provider"],
    },
    { name: "provider", dependencies: [] },
    { name: "test-provider", dependencies: [] },
  ],
  platform: [{ name: "runtime", internal: true, dependencies: [] }],
  shared: [],
  testApis: ["platform/runtime"],
  legacyRoots: [],
};

function rule(
  rules: readonly IForbiddenRuleType[],
  name: string,
): IRegularForbiddenRuleType {
  const found = rules.find((candidate) => candidate.name === name);
  if (!found || !("to" in found)) throw new Error(`Missing rule ${name}`);
  return found;
}

describe("buildRules", () => {
  test("allows only declared component dependencies", () => {
    const configuration = buildRules(architecture, "production");
    const consumerRule = rule(
      configuration.forbidden,
      "consumer-uses-declared-components-only",
    );
    expect(consumerRule.to.pathNot).toContain("src/modules/provider");
    expect(consumerRule.to.pathNot).not.toContain("src/modules/test-provider");
    expect(consumerRule.to.pathNot).not.toContain("src/platform/runtime");
  });

  test("rejects deep imports while allowing the public facade", () => {
    const configuration = buildRules(architecture, "production");
    const facadeRule = rule(
      configuration.forbidden,
      "provider-public-facade-only",
    );
    if (typeof facadeRule.to.pathNot !== "string") {
      throw new Error("Expected a string facade exclusion");
    }
    const rejected = new RegExp(facadeRule.to.pathNot);
    expect(rejected.test("src/modules/provider/index.ts")).toBe(true);
    expect(rejected.test("src/modules/provider/internal.ts")).toBe(false);
  });

  test("uses separate production dependencies and test dependencies", () => {
    const production = buildRules(architecture, "production");
    const testConfiguration = buildRules(architecture, "test");
    expect(production.options.exclude).toContain(".test");
    expect(production.options.exclude).toContain("__test__");
    expect(testConfiguration.options.exclude).not.toContain(".test");
    expect(
      rule(
        testConfiguration.forbidden,
        "consumer-uses-declared-components-only",
      ).to.pathNot,
    ).toContain("src/modules/test-provider");
  });

  test("rejects module imports of internal platform components", () => {
    const configuration = buildRules(architecture, "production");
    expect(
      rule(configuration.forbidden, "runtime-is-platform-internal").to.path,
    ).toContain("src/platform/runtime");
  });

  test("rejects production test API imports and external deep test imports", () => {
    const configuration = buildRules(architecture, "test");
    expect(
      rule(configuration.forbidden, "production-cannot-import-test-api"),
    ).toBeDefined();
    expect(
      rule(configuration.forbidden, "platform-runtime-test-facade-only").to
        .pathNot,
    ).toContain("__test__/index");
  });
});
