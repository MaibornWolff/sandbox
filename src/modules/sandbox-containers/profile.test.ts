import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

function readProfile(): string {
  return fs.readFileSync(
    path.join(PROJECT_ROOT, "docker", "configs", "profile"),
    "utf-8",
  );
}

describe("docker/configs/profile", () => {
  test("exports SANDBOX_PROFILE_LOADED so child processes inherit the guard", () => {
    const script = readProfile();
    // Must use export, not a bare assignment, so devbox (itself a bash script
    // sourced via BASH_ENV) inherits the variable and skips re-execution.
    expect(script).toContain("export SANDBOX_PROFILE_LOADED=1");
    expect(script).not.toMatch(/^SANDBOX_PROFILE_LOADED=1$/m);
  });

  test("returns early when SANDBOX_PROFILE_LOADED is already set", () => {
    const script = readProfile();
    const guardIndex = script.indexOf(
      `[ -n "\${SANDBOX_PROFILE_LOADED:-}" ] && return 0`,
    );
    expect(guardIndex).toBeGreaterThanOrEqual(0);
  });

  test("guard appears before all substantive content so appended lines are protected", () => {
    const script = readProfile();
    const guardIndex = script.indexOf(
      `[ -n "\${SANDBOX_PROFILE_LOADED:-}" ] && return 0`,
    );
    const exportIndex = script.indexOf("export SANDBOX_PROFILE_LOADED=1");
    const miseIndex = script.indexOf("mise activate");

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(exportIndex);
    expect(exportIndex).toBeLessThan(miseIndex);
  });
});
