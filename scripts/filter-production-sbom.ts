interface LicenseEntry {
  readonly name: string;
  readonly version: string;
}

interface SbomComponent {
  readonly name: string;
  readonly version: string;
  readonly "bom-ref": string;
}

interface SbomDependency {
  readonly ref: string;
  readonly dependsOn: readonly string[];
}

export interface CycloneDxSbom {
  readonly bomFormat: string;
  readonly metadata: {
    readonly component: { readonly "bom-ref": string; readonly name: string };
  };
  readonly components: readonly SbomComponent[];
  readonly dependencies: readonly SbomDependency[];
}

export function filterProductionSbom(
  sbom: CycloneDxSbom,
  licenseReport: Record<string, LicenseEntry>,
  packageName: string,
): CycloneDxSbom {
  if (
    sbom.bomFormat !== "CycloneDX" ||
    !Array.isArray(sbom.components) ||
    !Array.isArray(sbom.dependencies)
  ) {
    throw new Error("npm sbom did not return a CycloneDX dependency graph");
  }

  const production = new Set(
    Object.values(licenseReport).map(
      ({ name, version }) => `${name}@${version}`,
    ),
  );
  const root = sbom.metadata.component["bom-ref"];
  production.delete(root);
  const components = sbom.components.filter((component) =>
    production.has(`${component.name}@${component.version}`),
  );
  const found = new Set(
    components.map(({ name, version }) => `${name}@${version}`),
  );
  const missing = [...production].filter((packageId) => !found.has(packageId));
  if (missing.length > 0) {
    throw new Error(
      `SBOM is missing production packages: ${missing.join(", ")}`,
    );
  }

  const refs = new Set([
    root,
    ...components.map((component) => component["bom-ref"]),
  ]);
  const dependencies = sbom.dependencies
    .filter(({ ref }) => refs.has(ref))
    .map((dependency) => ({
      ...dependency,
      dependsOn: dependency.dependsOn.filter((ref: string) => refs.has(ref)),
    }));
  return {
    ...sbom,
    metadata: {
      ...sbom.metadata,
      component: { ...sbom.metadata.component, name: packageName },
    },
    components,
    dependencies,
  };
}
