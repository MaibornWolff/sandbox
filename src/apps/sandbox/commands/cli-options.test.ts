import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  mergeCliOptions,
  normalizeCliOptions,
  validateRunOptions,
} from "./cli-options.js";

describe("CLI option behavior", () => {
  test("normalizes Commander no-build state", () => {
    expect(normalizeCliOptions({ build: false, verbose: true })).toEqual({
      noBuild: true,
      verbose: true,
    });
  });

  test("merges normalized global and command options", () => {
    expect(
      mergeCliOptions(
        { build: false, trust: true },
        { readonly: true, verbose: true },
      ),
    ).toEqual({
      noBuild: true,
      trust: true,
      readonly: true,
      verbose: true,
    });
  });

  test("rejects silent and verbose together", () => {
    const command = new Command();
    command.exitOverride();
    command.configureOutput({ writeErr: () => undefined });

    expect(() =>
      validateRunOptions({ silent: true, verbose: true }, command),
    ).toThrow("--silent cannot be used with --verbose");
  });
});
