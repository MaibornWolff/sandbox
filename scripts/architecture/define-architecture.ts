export interface ComponentDefinition {
  readonly dependencies: readonly string[];
  readonly testDependencies?: readonly string[];
  readonly assets?: readonly string[];
  readonly internal?: boolean;
}

export interface ArchitectureComponent extends ComponentDefinition {
  readonly name: string;
}

export interface ArchitectureDefinition {
  readonly apps: readonly ArchitectureComponent[];
  readonly modules: readonly ArchitectureComponent[];
  readonly platform: readonly ArchitectureComponent[];
  readonly shared: readonly ArchitectureComponent[];
  readonly testApis: readonly string[];
  readonly legacyRoots: readonly string[];
}

type ComponentMap = Readonly<Record<string, ComponentDefinition>>;
type ComponentName<T extends ComponentMap> = Extract<keyof T, string>;
type Dependencies<T extends ComponentMap, Names extends string> = {
  readonly [Name in keyof T]: Omit<
    T[Name],
    "dependencies" | "testDependencies"
  > & {
    readonly dependencies: readonly Names[];
    readonly testDependencies?: readonly Names[];
  };
};

type ArchitectureInput<
  Apps extends ComponentMap,
  Modules extends ComponentMap,
  Platform extends ComponentMap,
  Shared extends ComponentMap,
> = {
  readonly apps: Dependencies<
    Apps,
    ComponentName<Modules> | ComponentName<Platform> | ComponentName<Shared>
  >;
  readonly modules: Dependencies<
    Modules,
    ComponentName<Modules> | ComponentName<Platform> | ComponentName<Shared>
  >;
  readonly platform: Dependencies<
    Platform,
    ComponentName<Platform> | ComponentName<Shared>
  >;
  readonly shared: Dependencies<Shared, ComponentName<Shared>>;
  readonly testApis: readonly (
    | `apps/${ComponentName<Apps>}`
    | `modules/${ComponentName<Modules>}`
    | `platform/${ComponentName<Platform>}`
    | `shared/${ComponentName<Shared>}`
  )[];
  readonly legacyRoots: readonly string[];
};

function entries(map: ComponentMap): ArchitectureComponent[] {
  return Object.entries(map).map(([name, component]) => ({
    name,
    dependencies: component.dependencies,
    ...(component.testDependencies
      ? { testDependencies: component.testDependencies }
      : {}),
    ...(component.assets ? { assets: component.assets } : {}),
    ...(component.internal ? { internal: true } : {}),
  }));
}

export function defineArchitecture<
  const Apps extends ComponentMap,
  const Modules extends ComponentMap,
  const Platform extends ComponentMap,
  const Shared extends ComponentMap,
>(
  definition: ArchitectureInput<Apps, Modules, Platform, Shared>,
): ArchitectureDefinition {
  return {
    apps: entries(definition.apps),
    modules: entries(definition.modules),
    platform: entries(definition.platform),
    shared: entries(definition.shared),
    testApis: definition.testApis,
    legacyRoots: definition.legacyRoots,
  };
}

type GroupName = "apps" | "modules" | "platform" | "shared";
type GroupedComponent = ArchitectureComponent & { readonly group: GroupName };

function collectInternalNames(
  components: readonly GroupedComponent[],
): ReadonlySet<string> {
  return new Set(
    components
      .filter(({ internal }) => internal)
      .map(({ group, name }) => {
        if (group !== "platform") {
          throw new Error(`Internal component ${name} must belong to platform`);
        }
        return name;
      }),
  );
}

function validateDependencies(options: {
  readonly components: readonly GroupedComponent[];
  readonly names: ReadonlySet<string>;
  readonly groupByName: ReadonlyMap<string, GroupName>;
  readonly internalNames: ReadonlySet<string>;
}): void {
  for (const component of options.components) {
    const dependencies = [
      ...component.dependencies,
      ...(component.testDependencies ?? []),
    ];
    assertUnique(dependencies, `${component.name} dependency`);
    for (const dependency of dependencies) {
      if (dependency === component.name) {
        throw new Error(`Component ${component.name} cannot depend on itself`);
      }
      if (!options.names.has(dependency)) {
        throw new Error(
          `Component ${component.name} has unknown dependency ${dependency}`,
        );
      }
      assertPermittedLayerDependency(
        component.group,
        component.name,
        options.groupByName.get(dependency),
        dependency,
      );
      if (
        options.internalNames.has(dependency) &&
        (component.group === "apps" || component.group === "modules")
      ) {
        throw new Error(
          `Component ${component.name} cannot depend on internal platform component ${dependency}`,
        );
      }
    }
  }
}

export function validateArchitecture(
  architecture: ArchitectureDefinition,
): void {
  const groups = [
    ["apps", architecture.apps],
    ["modules", architecture.modules],
    ["platform", architecture.platform],
    ["shared", architecture.shared],
  ] as const;
  const allComponents = groups.flatMap(([group, components]) =>
    components.map((component) => ({ group, ...component })),
  );
  const names = new Set(allComponents.map(({ name }) => name));
  const groupByName = new Map(
    allComponents.map(({ group, name }) => [name, group]),
  );
  const internalNames = collectInternalNames(allComponents);

  for (const [group, components] of groups) {
    assertUnique(
      components.map(({ name }) => name),
      `${group} component`,
    );
  }
  assertUnique(
    allComponents.map(({ name }) => name),
    "component name",
  );
  assertUnique(architecture.legacyRoots, "legacy root");
  assertUnique(architecture.testApis, "test API");
  assertUnique(
    allComponents.flatMap(({ assets }) => assets ?? []),
    "asset root owner",
  );

  for (const testApi of architecture.testApis) {
    const [group, name, extra] = testApi.split("/");
    if (extra || groupByName.get(name ?? "") !== group) {
      throw new Error(`Test API has unknown owner ${testApi}`);
    }
  }

  validateDependencies({
    components: allComponents,
    names,
    groupByName,
    internalNames,
  });
  assertNoCycles(allComponents);
}

function assertPermittedLayerDependency(
  sourceGroup: "apps" | "modules" | "platform" | "shared",
  sourceName: string,
  targetGroup: "apps" | "modules" | "platform" | "shared" | undefined,
  targetName: string,
): void {
  const permittedTargets = {
    apps: new Set(["modules", "platform", "shared"]),
    modules: new Set(["modules", "platform", "shared"]),
    platform: new Set(["platform", "shared"]),
    shared: new Set(["shared"]),
  }[sourceGroup];
  if (!targetGroup || !permittedTargets.has(targetGroup)) {
    throw new Error(
      `Component ${sourceName} cannot depend on ${targetGroup ?? "unknown"} component ${targetName}`,
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function assertNoCycles(components: readonly ArchitectureComponent[]): void {
  const graph = new Map(
    components.map((component) => [component.name, component.dependencies]),
  );
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string, path: readonly string[]): void {
    if (visiting.has(name)) {
      throw new Error(
        `Declared architecture cycle: ${[...path, name].join(" -> ")}`,
      );
    }
    if (visited.has(name)) return;

    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) {
      visit(dependency, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
  }

  for (const component of components) visit(component.name, []);
}
