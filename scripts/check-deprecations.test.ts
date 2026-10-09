import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import { checkDeprecations } from "./check-deprecations.js";

const compilerOptions = {
  noLib: true,
  types: [],
  module: "ESNext",
  moduleResolution: "Bundler",
};
const defaultConfig = {
  compilerOptions,
  include: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
};

async function createFixture(
  files: Readonly<Record<string, string>>,
  config: object = defaultConfig,
) {
  const root = createTestDir("deprecation-check");
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify(config));
  for (const [filename, content] of Object.entries(files)) {
    const destination = path.join(root, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  return { root, [Symbol.dispose]: () => cleanupTestDir(root) };
}

test("rejects deprecated function use with its source location", async () => {
  using fixture = await createFixture({
    "src/example.ts":
      "/** @deprecated Use currentFeature. */\nfunction oldFeature() {}\noldFeature();\n",
  });
  const result = checkDeprecations(fixture.root);
  expect(result.exitCode).toBe(1);
  expect(result.violations).toMatchObject([
    { file: "src/example.ts", line: 3, column: 1 },
  ]);
  expect(result.violations[0]?.message).toContain("deprecated");
});

test("rejects deprecated dependency methods used by scripts", async () => {
  using fixture = await createFixture({
    "node_modules/example/index.d.ts":
      "export declare const schema: {\n/** @deprecated Use looseObject. */\npassthrough(): void;\n};\n",
    "scripts/release.ts":
      'import { schema } from "example";\nschema.passthrough();\n',
  });
  const result = checkDeprecations(fixture.root);
  expect(result.exitCode).toBe(1);
  expect(result.violations).toMatchObject([
    { file: "scripts/release.ts", line: 2 },
  ]);
});

test("checks referenced projects and does not report the same use twice", async () => {
  const project = JSON.stringify({
    compilerOptions,
    include: ["tests/**/*.ts"],
  });
  using fixture = await createFixture(
    {
      "tests/example.test.ts":
        "/** @deprecated Use currentFeature. */\nfunction oldFeature() {}\noldFeature();\n",
      "tsconfig.tests.json": project,
      "tsconfig.more-tests.json": project,
    },
    {
      files: [],
      references: [
        { path: "./tsconfig.tests.json" },
        { path: "./tsconfig.more-tests.json" },
      ],
    },
  );
  const result = checkDeprecations(fixture.root);
  expect(result.exitCode).toBe(1);
  expect(result.violations).toHaveLength(1);
  expect(result.violations[0]?.file).toBe("tests/example.test.ts");
});

test("allows current APIs and unused deprecated declarations", async () => {
  using fixture = await createFixture({
    "src/example.ts":
      "/** @deprecated Use currentFeature. */\nfunction oldFeature() {}\nfunction currentFeature() {}\ncurrentFeature();\n",
  });
  expect(checkDeprecations(fixture.root)).toEqual({
    exitCode: 0,
    violations: [],
  });
});

test("does not scan dependency implementation files", async () => {
  using fixture = await createFixture({
    "node_modules/example/index.d.ts":
      "export declare function currentFeature(): void;\n",
    "node_modules/example/internal.ts":
      "/** @deprecated */\nfunction oldFeature() {}\noldFeature();\n",
    "src/example.ts":
      'import { currentFeature } from "example";\ncurrentFeature();\n',
  });
  expect(checkDeprecations(fixture.root)).toEqual({
    exitCode: 0,
    violations: [],
  });
});

test("fails rather than silently skipping a missing referenced project", async () => {
  using fixture = await createFixture(
    {},
    { files: [], references: [{ path: "./missing" }] },
  );
  expect(() => checkDeprecations(fixture.root)).toThrow("Cannot read file");
});

test("fails on invalid TypeScript configuration", async () => {
  using fixture = await createFixture({ "src/example.ts": "export {};\n" });
  await writeFile(path.join(fixture.root, "tsconfig.json"), "{ invalid");
  expect(() => checkDeprecations(fixture.root)).toThrow();
});
