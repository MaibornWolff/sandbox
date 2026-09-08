import { describe, expect, test } from "bun:test";
import { getSetupInstructions } from "./x11-setup.js";

/**
 * X11 Setup Validation Tests
 *
 * Note: checkX11Setup() is platform-dependent and relies on system state,
 * making it difficult to unit test without extensive mocking.
 *
 * We focus on testing pure functions that can be tested in isolation.
 */

describe("getSetupInstructions", () => {
  test("returns instructions for macOS", () => {
    const instructions = getSetupInstructions("darwin");

    expect(Array.isArray(instructions)).toBe(true);
    expect(instructions.length).toBeGreaterThan(0);

    const text = instructions.join("\n");
    expect(text).toContain("XQuartz");
    expect(text).toContain("brew install");
  });

  test("returns instructions for Linux", () => {
    const instructions = getSetupInstructions("linux");

    expect(Array.isArray(instructions)).toBe(true);
    expect(instructions.length).toBeGreaterThan(0);

    const text = instructions.join("\n");
    expect(text).toContain("DISPLAY");
    expect(text).toContain("xhost");
  });

  test("returns instructions for Windows", () => {
    const instructions = getSetupInstructions("win32");

    expect(Array.isArray(instructions)).toBe(true);
    expect(instructions.length).toBeGreaterThan(0);

    const text = instructions.join("\n");
    expect(text).toContain("VcXsrv");
  });

  test("handles unknown platforms", () => {
    const instructions = getSetupInstructions("unknown" as NodeJS.Platform);

    expect(Array.isArray(instructions)).toBe(true);
    expect(instructions.length).toBeGreaterThan(0);

    const text = instructions.join("\n");
    expect(text).toContain("not fully supported");
  });
});

/**
 * Integration test notes:
 *
 * checkX11Setup() requires testing on actual systems because it:
 * 1. Checks if X server processes are running (pgrep, tasklist)
 * 2. Reads system preferences (defaults on macOS)
 * 3. Verifies socket existence (platform-dependent paths)
 * 4. Runs xhost to check access control
 *
 * These are environmental checks that are best validated through:
 * - Manual testing on each platform
 * - Integration tests in CI with X servers set up
 * - User testing via `sandbox setup-x11` command
 */
