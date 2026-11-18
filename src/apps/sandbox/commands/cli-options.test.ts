import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mergeCliOptions, validateRunOptions } from "./cli-options.js";

describe("CLI option behavior", () => {
  test("preserves disabled global options when merging command options", () => {
    expect(
      mergeCliOptions(
        { build: false, wrapper: false, trust: true },
        { readonly: true, verbose: true },
      ),
    ).toEqual({
      build: false,
      wrapper: false,
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
