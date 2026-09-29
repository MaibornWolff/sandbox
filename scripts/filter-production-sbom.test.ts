import { expect, test } from "bun:test";
import {
  type CycloneDxSbom,
  filterProductionSbom,
} from "./filter-production-sbom.js";

const sbom: CycloneDxSbom = {
  bomFormat: "CycloneDX",
  metadata: { component: { "bom-ref": "sandbox@1.0.0", name: "local-folder" } },
  components: [
    { name: "shared", version: "2.0.0", "bom-ref": "shared@2.0.0" },
    { name: "dev-only", version: "3.0.0", "bom-ref": "dev-only@3.0.0" },
    { name: "transitive", version: "4.0.0", "bom-ref": "transitive@4.0.0" },
  ],
  dependencies: [
    {
      ref: "sandbox@1.0.0",
      dependsOn: ["shared@2.0.0", "dev-only@3.0.0"],
    },
    { ref: "shared@2.0.0", dependsOn: ["transitive@4.0.0"] },
    { ref: "dev-only@3.0.0", dependsOn: [] },
    { ref: "transitive@4.0.0", dependsOn: [] },
  ],
};

const production = {
  root: { name: "sandbox", version: "1.0.0" },
  shared: { name: "shared", version: "2.0.0" },
  transitive: { name: "transitive", version: "4.0.0" },
};

test("keeps all production components and dependency edges without dev-only packages", () => {
  const result = filterProductionSbom(sbom, production, "sandbox");
  expect(result.metadata.component.name).toBe("sandbox");
  expect(result.components.map((component) => component.name)).toEqual([
    "shared",
    "transitive",
  ]);
  expect(result.dependencies).toEqual([
    { ref: "sandbox@1.0.0", dependsOn: ["shared@2.0.0"] },
    { ref: "shared@2.0.0", dependsOn: ["transitive@4.0.0"] },
    { ref: "transitive@4.0.0", dependsOn: [] },
  ]);
});

test("rejects an incomplete SBOM instead of shipping it", () => {
  expect(() =>
    filterProductionSbom(
      sbom,
      {
        ...production,
        missing: { name: "missing", version: "1.0.0" },
      },
      "sandbox",
    ),
  ).toThrow("SBOM is missing production packages: missing@1.0.0");
});
