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

test("keeps npm aliases and their dependency edges by canonical package identity", () => {
  const aliases = [
    {
      name: "node-ws",
      version: "8.21.3",
      "bom-ref": "node-ws@8.21.3",
      purl: "pkg:npm/ws@8.21.3",
    },
    {
      name: "native-alias",
      version: "1.0.0",
      "bom-ref": "native-alias@1.0.0",
      purl: "pkg:npm/%40example/native@1.0.0",
    },
  ];
  const dependencies = [
    {
      ref: "sandbox@1.0.0",
      dependsOn: aliases.map((component) => component["bom-ref"]),
    },
    ...aliases.map((component) => ({
      ref: component["bom-ref"],
      dependsOn: [],
    })),
  ];
  const result = filterProductionSbom(
    { ...sbom, components: aliases, dependencies },
    {
      root: production.root,
      ws: { name: "ws", version: "8.21.3" },
      native: { name: "@example/native", version: "1.0.0" },
    },
    "sandbox",
  );
  expect(result.components).toEqual(aliases);
  expect(result.dependencies).toEqual(dependencies);
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
