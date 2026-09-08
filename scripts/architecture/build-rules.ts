import type { IForbiddenRuleType } from "dependency-cruiser";
import type {
  ArchitectureComponent,
  ArchitectureDefinition,
} from "./define-architecture.js";

export interface DependencyCruiserConfiguration {
  readonly forbidden: readonly IForbiddenRuleType[];
  readonly options: {
    readonly doNotFollow: string;
    readonly exclude: string;
    readonly tsPreCompilationDeps: boolean;
    readonly enhancedResolveOptions: {
      readonly conditionNames: readonly string[];
      readonly exportsFields: readonly string[];
    };
  };
}

export type ArchitectureScan = "production" | "test";

const TARGET_ROOTS = "src/(?:apps|modules|platform|shared)";
const TEST_FILE_PATTERN = "(?:\\.test\\.ts$|^src/test/|/__test__/)";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function componentPath(group: string, name: string): string {
  return `src/${group}/${escapeRegExp(name)}`;
}

function allComponents(architecture: ArchitectureDefinition): readonly {
  group: "apps" | "modules" | "platform" | "shared";
  component: ArchitectureComponent;
}[] {
  return (["apps", "modules", "platform", "shared"] as const).flatMap((group) =>
    architecture[group].map((component) => ({ group, component })),
  );
}

function baseRules(): IForbiddenRuleType[] {
  return [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-orphans-in-migrated-components",
      severity: "error",
      from: {
        orphan: true,
        path: `^${TARGET_ROOTS}/`,
        pathNot: "(?:\\.test\\.ts$|\\.d\\.ts$|/index\\.ts$|/__test__/)",
      },
      to: {},
    },
  ];
}

function layerRules(): IForbiddenRuleType[] {
  return [
    {
      name: "shared-has-no-higher-layer-dependencies",
      severity: "error",
      from: { path: "^src/shared/" },
      to: { path: "^src/(?:apps|modules|platform)/" },
    },
    {
      name: "platform-has-no-product-dependencies",
      severity: "error",
      from: { path: "^src/platform/" },
      to: { path: "^src/(?:apps|modules)/" },
    },
    {
      name: "modules-do-not-import-apps",
      severity: "error",
      from: { path: "^src/modules/" },
      to: { path: "^src/apps/" },
    },
  ];
}

function exactDependencyRules(
  architecture: ArchitectureDefinition,
  scan: ArchitectureScan,
): IForbiddenRuleType[] {
  const components = allComponents(architecture);
  const pathByName = new Map(
    components.map(({ group, component }) => [
      component.name,
      componentPath(group, component.name),
    ]),
  );

  return components.map(({ group, component }) => {
    const dependencies = [
      ...component.dependencies,
      ...(scan === "test" ? (component.testDependencies ?? []) : []),
    ];
    const allowed = [
      componentPath(group, component.name),
      ...dependencies.map((dependency) => {
        const path = pathByName.get(dependency);
        if (!path) throw new Error(`Unknown dependency ${dependency}`);
        return path;
      }),
    ];
    return {
      name: `${component.name}-uses-declared-components-only`,
      severity: "error",
      from: { path: `^${componentPath(group, component.name)}/` },
      to: {
        path: `^${TARGET_ROOTS}/`,
        pathNot: `^(?:${allowed.join("|")})/`,
      },
    };
  });
}

function facadeRules(
  architecture: ArchitectureDefinition,
): IForbiddenRuleType[] {
  return allComponents(architecture).map(({ group, component }) => {
    const root = componentPath(group, component.name);
    return {
      name: `${component.name}-public-facade-only`,
      severity: "error",
      from: { pathNot: `^${root}/` },
      to: {
        path: `^${root}/`,
        pathNot: `^${root}/(?:index\\.ts|__test__/index\\.ts)$`,
      },
    };
  });
}

function internalComponentRules(
  architecture: ArchitectureDefinition,
): IForbiddenRuleType[] {
  return allComponents(architecture)
    .filter(({ component }) => component.internal)
    .map(({ group, component }) => ({
      name: `${component.name}-is-platform-internal`,
      severity: "error" as const,
      from: { path: "^src/(?:apps|modules)/" },
      to: { path: `^${componentPath(group, component.name)}/` },
    }));
}

function applicationRules(
  architecture: ArchitectureDefinition,
): IForbiddenRuleType[] {
  return architecture.apps.map((component) => {
    const root = componentPath("apps", component.name);
    return {
      name: `${component.name}-application-is-not-importable`,
      severity: "error",
      from: { pathNot: `^${root}/` },
      to: { path: `^${root}/` },
    };
  });
}

function testApiRules(
  architecture: ArchitectureDefinition,
  scan: ArchitectureScan,
): IForbiddenRuleType[] {
  const productionRule: IForbiddenRuleType = {
    name: "production-cannot-import-test-api",
    severity: "error",
    from: { pathNot: TEST_FILE_PATTERN },
    to: { path: "/__test__/" },
  };
  if (scan === "production") return [productionRule];

  return [
    productionRule,
    ...architecture.testApis.map((owner) => {
      const root = `src/${escapeRegExp(owner)}`;
      return {
        name: `${owner.replace("/", "-")}-test-facade-only`,
        severity: "error" as const,
        from: { pathNot: `^${root}/__test__/` },
        to: {
          path: `^${root}/__test__/`,
          pathNot: `^${root}/__test__/index\\.ts$`,
        },
      };
    }),
  ];
}

export function buildRules(
  architecture: ArchitectureDefinition,
  scan: ArchitectureScan,
): DependencyCruiserConfiguration {
  return {
    forbidden: [
      ...baseRules(),
      ...layerRules(),
      ...exactDependencyRules(architecture, scan),
      ...facadeRules(architecture),
      ...internalComponentRules(architecture),
      ...applicationRules(architecture),
      ...testApiRules(architecture, scan),
    ],
    options: {
      doNotFollow: "node_modules",
      exclude:
        scan === "production"
          ? TEST_FILE_PATTERN
          : "(?:^tests/e2e/|node_modules/)",
      tsPreCompilationDeps: true,
      enhancedResolveOptions: {
        conditionNames: ["types", "import", "require", "node", "default"],
        exportsFields: ["exports"],
      },
    },
  };
}
