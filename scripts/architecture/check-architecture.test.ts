import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ArchitectureScan, buildRules } from "./build-rules.js";
import {
  runArchitectureCheck,
  validateArchitectureDirectories,
} from "./check-architecture.js";
import type { ArchitectureDefinition } from "./define-architecture.js";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..", "..");
const directories: string[] = [];

function emptyArchitecture(
  overrides: Partial<ArchitectureDefinition> = {},
): ArchitectureDefinition {
  return {
    apps: [],
    modules: [],
    platform: [],
    shared: [],
    testApis: [],
    legacyRoots: [],
    ...overrides,
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-architecture-"));
  directories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  return root;
}

async function writeCruiseFixture(
  source: string,
): Promise<{ architecture: ArchitectureDefinition; root: string }> {
  const root = await createRoot();
  await mkdir(path.join(root, "src", "modules", "consumer"), {
    recursive: true,
  });
  await mkdir(path.join(root, "src", "modules", "provider"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "src", "modules", "consumer", "index.ts"),
    source,
  );
  await writeFile(
    path.join(root, "src", "modules", "provider", "index.ts"),
    'export { value } from "./internal.js";\n',
  );
  await writeFile(
    path.join(root, "src", "modules", "provider", "internal.ts"),
    'export const value = "provider";\n',
  );
  const tsconfig = {
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "bundler",
      target: "ES2022",
      baseUrl: ".",
      paths: {
        "#modules/*": ["src/modules/*"],
      },
    },
    include: ["src/**/*.ts"],
  };
  await writeFile(
    path.join(root, "tsconfig.src.json"),
    JSON.stringify(tsconfig),
  );
  await writeFile(
    path.join(root, "tsconfig.test.json"),
    JSON.stringify(tsconfig),
  );
  return {
    root,
    architecture: emptyArchitecture({
      modules: [
        { name: "consumer", dependencies: ["provider"] },
        { name: "provider", dependencies: [] },
      ],
    }),
  };
}

async function writeTestApiFixture(options: {
  readonly productionImportsTestApi: boolean;
}): Promise<{ architecture: ArchitectureDefinition; root: string }> {
  const root = await createRoot();
  const consumerDirectory = path.join(root, "src", "modules", "consumer");
  const runtimeDirectory = path.join(root, "src", "platform", "runtime");
  await mkdir(path.join(runtimeDirectory, "__test__"), { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });
  await writeFile(
    path.join(runtimeDirectory, "index.ts"),
    "export interface Runtime { run(): void }\n",
  );
  await writeFile(
    path.join(runtimeDirectory, "__test__", "fake.ts"),
    'import type { Runtime } from "../index.js";\nexport class FakeRuntime implements Runtime { run(): void {} }\n',
  );
  await writeFile(
    path.join(runtimeDirectory, "__test__", "index.ts"),
    'export { FakeRuntime } from "./fake.js";\n',
  );
  await writeFile(
    path.join(consumerDirectory, "index.ts"),
    options.productionImportsTestApi
      ? 'export { FakeRuntime } from "../../platform/runtime/__test__/index.js";\n'
      : "export const consumer = true;\n",
  );
  await writeFile(
    path.join(consumerDirectory, "consumer.test.ts"),
    'import { FakeRuntime } from "../../platform/runtime/__test__/fake.js";\nnew FakeRuntime().run();\n',
  );
  const sourceConfig = {
    compilerOptions: { module: "ESNext", moduleResolution: "bundler" },
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.test.ts", "src/**/__test__/**"],
  };
  const testConfig = {
    compilerOptions: { module: "ESNext", moduleResolution: "bundler" },
    include: ["src/**/*.ts"],
  };
  await writeFile(
    path.join(root, "tsconfig.src.json"),
    JSON.stringify(sourceConfig),
  );
  await writeFile(
    path.join(root, "tsconfig.test.json"),
    JSON.stringify(testConfig),
  );
  return {
    root,
    architecture: emptyArchitecture({
      modules: [{ name: "consumer", dependencies: ["runtime"] }],
      platform: [{ name: "runtime", dependencies: [] }],
      testApis: ["platform/runtime"],
    }),
  };
}

async function runFixtureCruise(
  root: string,
  architecture: ArchitectureDefinition,
  scan: ArchitectureScan,
): Promise<{ summary: { violations: { rule: { name: string } }[] } }> {
  const configPath = path.join(root, `architecture-${scan}.json`);
  await writeFile(configPath, JSON.stringify(buildRules(architecture, scan)));
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(
        PROJECT_ROOT,
        "scripts",
        "architecture",
        "run-dependency-cruiser.mjs",
      ),
      configPath,
      "src",
      `tsconfig.${scan === "production" ? "src" : "test"}.json`,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return JSON.parse(stdout);
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("architecture directory validation", () => {
  test("rejects an undeclared top-level source file", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "src", "foo.ts"),
      "export const foo = true;\n",
    );
    await expect(
      validateArchitectureDirectories(emptyArchitecture(), root),
    ).rejects.toThrow("Undeclared top-level source file: src/foo.ts");
  });

  test("rejects a top-level source symlink", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "target.ts"), "export const foo = true;\n");
    await symlink(
      path.join(root, "target.ts"),
      path.join(root, "src", "foo.ts"),
      "file",
    );
    await expect(
      validateArchitectureDirectories(emptyArchitecture(), root),
    ).rejects.toThrow("Undeclared top-level source file: src/foo.ts");
  });

  test("allows the global type declaration file", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "src", "global.d.ts"),
      "declare const foo: string;\n",
    );
    await expect(
      validateArchitectureDirectories(emptyArchitecture(), root),
    ).resolves.toBeUndefined();
  });

  test("rejects a direct file in a component group", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src", "modules"), { recursive: true });
    await writeFile(
      path.join(root, "src", "modules", "rogue.ts"),
      "export const rogue = true;\n",
    );

    await expect(
      validateArchitectureDirectories(emptyArchitecture(), root),
    ).rejects.toThrow("Non-directory entry in src/modules: rogue.ts");
  });

  test("rejects a direct symlink in a component group", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src", "modules"), { recursive: true });
    await writeFile(
      path.join(root, "target.ts"),
      "export const rogue = true;\n",
    );
    await symlink(
      path.join(root, "target.ts"),
      path.join(root, "src", "modules", "rogue.ts"),
      "file",
    );

    await expect(
      validateArchitectureDirectories(emptyArchitecture(), root),
    ).rejects.toThrow("Non-directory entry in src/modules: rogue.ts");
  });

  test("rejects an undeclared component directory", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src", "modules", "unknown"), {
      recursive: true,
    });
    await expect(
      validateArchitectureDirectories(emptyArchitecture(), root),
    ).rejects.toThrow("Undeclared modules component directory: unknown");
  });

  test("rejects a missing component directory", async () => {
    const root = await createRoot();
    await expect(
      validateArchitectureDirectories(
        emptyArchitecture({
          modules: [{ name: "missing", dependencies: [] }],
        }),
        root,
      ),
    ).rejects.toThrow("Missing modules component directory: missing");
  });

  test("rejects a component without an index facade", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src", "modules", "feature"), {
      recursive: true,
    });
    await expect(
      validateArchitectureDirectories(
        emptyArchitecture({
          modules: [{ name: "feature", dependencies: [] }],
        }),
        root,
      ),
    ).rejects.toThrow("Missing facade: src/modules/feature/index.ts");
  });

  test("rejects a missing owned asset root", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src", "modules", "feature"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "src", "modules", "feature", "index.ts"),
      "export const feature = true;\n",
    );
    await expect(
      validateArchitectureDirectories(
        emptyArchitecture({
          modules: [
            { name: "feature", dependencies: [], assets: ["templates"] },
          ],
        }),
        root,
      ),
    ).rejects.toThrow("Missing asset root owned by modules/feature: templates");
  });
});

describe("dependency-cruiser adapter", () => {
  test("rejects a deep component import", async () => {
    const { architecture, root } = await writeCruiseFixture(
      'import { value } from "../provider/internal.js";\nexport { value };\n',
    );
    const result = await runFixtureCruise(root, architecture, "production");
    expect(result.summary.violations.map(({ rule }) => rule.name)).toContain(
      "provider-public-facade-only",
    );
  });

  test("allows an approved index facade import", async () => {
    const { architecture, root } = await writeCruiseFixture(
      'import { value } from "../provider/index.js";\nexport { value };\n',
    );
    const result = await runFixtureCruise(root, architecture, "production");
    expect(result.summary.violations).toEqual([]);
  });

  test("resolves an approved index facade through a source alias", async () => {
    const { architecture, root } = await writeCruiseFixture(
      'import { value } from "#modules/provider/index.js";\nexport { value };\n',
    );
    const result = await runFixtureCruise(root, architecture, "production");
    expect(result.summary.violations).toEqual([]);
  });

  test("applies architecture rules to aliases with runtime package mappings", async () => {
    const { architecture, root } = await writeCruiseFixture(
      'import { value } from "#modules/provider/internal.js";\nexport { value };\n',
    );
    await mkdir(path.join(root, "dist", "modules", "provider"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "dist", "modules", "provider", "internal.js"),
      'export const value = "compiled";\n',
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        type: "module",
        imports: {
          "#modules/*": {
            types: "./src/modules/*",
            default: "./dist/modules/*",
          },
        },
      }),
    );
    const result = await runFixtureCruise(root, architecture, "production");
    expect(result.summary.violations.map(({ rule }) => rule.name)).toContain(
      "provider-public-facade-only",
    );
  });

  test("rejects a cross-layer import", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src", "shared", "text"), { recursive: true });
    await mkdir(path.join(root, "src", "modules", "provider"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "src", "shared", "text", "index.ts"),
      'export { value } from "../../modules/provider/index.js";\n',
    );
    await writeFile(
      path.join(root, "src", "modules", "provider", "index.ts"),
      'export const value = "provider";\n',
    );
    const tsconfig = {
      compilerOptions: { module: "ESNext", moduleResolution: "bundler" },
      include: ["src/**/*.ts"],
    };
    await writeFile(
      path.join(root, "tsconfig.src.json"),
      JSON.stringify(tsconfig),
    );
    const architecture = emptyArchitecture({
      modules: [{ name: "provider", dependencies: [] }],
      shared: [{ name: "text", dependencies: [] }],
    });
    const result = await runFixtureCruise(root, architecture, "production");
    expect(result.summary.violations.map(({ rule }) => rule.name)).toContain(
      "shared-has-no-higher-layer-dependencies",
    );
  });

  test("excludes tests from production and rejects deep test API imports in the test scan", async () => {
    const { architecture, root } = await writeTestApiFixture({
      productionImportsTestApi: false,
    });
    const production = await runFixtureCruise(root, architecture, "production");
    const testResult = await runFixtureCruise(root, architecture, "test");
    expect(production.summary.violations).toEqual([]);
    const testRules = testResult.summary.violations.map(
      ({ rule }) => rule.name,
    );
    expect(testRules).toContain("platform-runtime-test-facade-only");
    expect(testRules).not.toContain("no-circular");
  });

  test("rejects production imports from a test API during the test scan", async () => {
    const { architecture, root } = await writeTestApiFixture({
      productionImportsTestApi: true,
    });
    const result = await runFixtureCruise(root, architecture, "test");
    expect(result.summary.violations.map(({ rule }) => rule.name)).toContain(
      "production-cannot-import-test-api",
    );
  });
});

describe("runArchitectureCheck", () => {
  test("removes temporary config when the runner fails", async () => {
    const root = await createRoot();
    const temporaryDirectory = await createRoot();
    await expect(
      runArchitectureCheck(
        {
          architecture: emptyArchitecture(),
          rootDirectory: root,
          temporaryDirectory,
        },
        {
          runCruise: () => Promise.reject(new Error("runner failed")),
          scan: () => Promise.resolve([]),
        },
      ),
    ).rejects.toThrow("runner failed");
    expect(await readdir(temporaryDirectory)).toEqual(["src"]);
  });

  test("rejects a relative cross-component import", async () => {
    const { architecture, root } = await writeCruiseFixture(
      'import { value } from "../provider/index.js";\nconsole.log(value);\n',
    );
    await expect(
      runArchitectureCheck(
        { architecture, rootDirectory: root },
        {
          runCruise: () =>
            Promise.resolve({
              modules: [
                {
                  source: "src/modules/consumer/index.ts",
                  dependencies: [
                    {
                      resolved: "src/modules/provider/index.ts",
                      dependencyTypes: ["local", "import"],
                    },
                  ],
                },
              ],
              summary: { violations: [] },
            }),
          scan: () => Promise.resolve([]),
        },
      ),
    ).rejects.toThrow(
      "[cross-component-import-must-use-alias] src/modules/consumer/index.ts:1",
    );
  });

  test("rejects an alias import within the same component", async () => {
    const { architecture, root } = await writeCruiseFixture(
      'import "#modules/consumer/internal.js";\n',
    );
    await expect(
      runArchitectureCheck(
        { architecture, rootDirectory: root },
        {
          runCruise: () =>
            Promise.resolve({
              modules: [
                {
                  source: "src/modules/consumer/index.ts",
                  dependencies: [
                    {
                      resolved: "src/modules/provider/index.ts",
                      dependencyTypes: ["local", "import"],
                    },
                  ],
                },
              ],
              summary: { violations: [] },
            }),
          scan: () => Promise.resolve([]),
        },
      ),
    ).rejects.toThrow(
      "[same-component-import-must-be-relative] src/modules/consumer/index.ts:1",
    );
  });

  test("rejects stale declared dependencies", async () => {
    const { architecture, root } = await writeCruiseFixture(
      "export const consumer = true;\n",
    );
    await expect(
      runArchitectureCheck(
        { architecture, rootDirectory: root },
        {
          runCruise: () =>
            Promise.resolve({
              modules: [
                {
                  source: "src/modules/consumer/index.ts",
                  dependencies: [],
                },
                {
                  source: "src/modules/provider/index.ts",
                  dependencies: [],
                },
              ],
              summary: { violations: [] },
            }),
          scan: () => Promise.resolve([]),
        },
      ),
    ).rejects.toThrow(
      "[dependencies] modules/consumer declares unused dependency provider",
    );
  });

  test("rejects cross-component re-exports", async () => {
    const { architecture, root } = await writeCruiseFixture(
      'export { value } from "../provider/index.js";\n',
    );
    await expect(
      runArchitectureCheck(
        { architecture, rootDirectory: root },
        {
          runCruise: () =>
            Promise.resolve({
              modules: [
                {
                  source: "src/modules/consumer/index.ts",
                  dependencies: [
                    {
                      resolved: "src/modules/provider/index.ts",
                      dependencyTypes: ["local", "export"],
                    },
                  ],
                },
                {
                  source: "src/modules/provider/index.ts",
                  dependencies: [],
                },
              ],
              summary: { violations: [] },
            }),
          scan: () => Promise.resolve([]),
        },
      ),
    ).rejects.toThrow(
      "[re-export] modules/consumer re-exports from modules/provider",
    );
  });

  test("reports violations as a nonzero check failure", async () => {
    const root = await createRoot();
    await expect(
      runArchitectureCheck(
        { architecture: emptyArchitecture(), rootDirectory: root },
        {
          runCruise: ({ scan }) =>
            Promise.resolve({
              summary: {
                violations:
                  scan === "production"
                    ? [
                        {
                          rule: { name: "fixture-rule" },
                          from: "src/from.ts",
                          to: "src/to.ts",
                        },
                      ]
                    : [],
              },
            }),
          scan: () => Promise.resolve([]),
        },
      ),
    ).rejects.toThrow("[production] fixture-rule: src/from.ts -> src/to.ts");
  });
});
