import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scanImportBoundaries } from "./scan-import-boundaries.js";

describe("configuration service composition ownership", () => {
  test("allows only host composition and the co-located owner contract test to import the provider", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "architecture-configuration-provider-"),
    );
    const forbidden = path.join(root, "src", "modules", "example");
    const allowed = path.join(root, "src", "apps", "sandbox");
    const ownerTest = path.join(root, "src", "modules", "configuration");
    await mkdir(forbidden, { recursive: true });
    await mkdir(allowed, { recursive: true });
    await mkdir(ownerTest, { recursive: true });
    await writeFile(
      path.join(forbidden, "example.ts"),
      'import { provideConfigurationService as bindConfiguration } from "#modules/configuration/index.js";\n',
    );
    await writeFile(
      path.join(allowed, "application.ts"),
      'import { provideConfigurationService } from "#modules/configuration/index.js";\n',
    );
    await writeFile(
      path.join(ownerTest, "configuration-service.test.ts"),
      'import { provideConfigurationService } from "./configuration-service.js";\n',
    );
    try {
      const violations = await scanImportBoundaries(root);
      expect(violations.map((violation) => violation.rule)).toEqual([
        "configuration-provider-composition-only",
      ]);
      expect(violations[0]?.file).toContain("modules/example/example.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
