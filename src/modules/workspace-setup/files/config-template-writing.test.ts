import { describe, expect, test } from "bun:test";
import {
  injectNamedVolumePersistPaths,
  injectRuntime,
  readActiveRuntime,
} from "./config-template-writing.js";

describe("injectNamedVolumePersistPaths", () => {
  const nixVol = { path: "/nix", use_named_volume: "nix" };

  test("empty paths returns content unchanged", () => {
    const content = 'runtime = "docker"';
    expect(injectNamedVolumePersistPaths(content, [])).toBe(content);
  });

  test("appends persist_paths block when none exists", () => {
    const result = injectNamedVolumePersistPaths("", [nixVol]);
    expect(result).toContain("persist_paths = [");
    expect(result).toContain('use_named_volume = "nix"');
    expect(result).toContain('path = "/nix"');
  });

  test("injects into existing uncommented persist_paths array", () => {
    const content = 'persist_paths = [\n  { path = "~/.gradle" },\n]';
    const result = injectNamedVolumePersistPaths(content, [nixVol]);
    expect(result).toContain("~/.gradle");
    expect(result).toContain('use_named_volume = "nix"');
    expect((result.match(/persist_paths\s*=\s*\[/g) ?? []).length).toBe(1);
  });

  test("skips already-present use_named_volume entries", () => {
    const content =
      'persist_paths = [\n  { path = "/nix", use_named_volume = "nix" },\n]';
    const result = injectNamedVolumePersistPaths(content, [nixVol]);
    expect(result).toBe(content);
  });

  test("does not inject into commented-out persist_paths", () => {
    const content = '# persist_paths = [\n#   { path = "~/.gradle" },\n# ]';
    const result = injectNamedVolumePersistPaths(content, [nixVol]);
    expect(result).toContain("persist_paths = [");
    expect(result).toContain('use_named_volume = "nix"');
  });

  test("injects multiple volumes", () => {
    const result = injectNamedVolumePersistPaths("", [
      nixVol,
      { path: "/data", use_named_volume: "mydata" },
    ]);
    expect(result).toContain('use_named_volume = "nix"');
    expect(result).toContain('use_named_volume = "mydata"');
  });
});

describe("injectRuntime", () => {
  const template =
    '# Runtime docs\n# runtime = "docker"\n\n# [runtimes.apple-container]\n';

  test("activates the commented runtime line", () => {
    expect(injectRuntime(template, "podman")).toBe(
      '# Runtime docs\nruntime = "podman"\n\n# [runtimes.apple-container]\n',
    );
  });

  test("leaves the template unchanged without a runtime", () => {
    expect(injectRuntime(template, undefined)).toBe(template);
  });

  test("prepends a runtime line when no commented line exists", () => {
    expect(injectRuntime("[runtimes]\n", "docker")).toBe(
      'runtime = "docker"\n[runtimes]\n',
    );
  });
});

describe("readActiveRuntime", () => {
  test("reads an active top-level runtime", () => {
    expect(readActiveRuntime('# x\nruntime = "podman" # local\n')).toBe(
      "podman",
    );
  });

  test("ignores commented, unknown, and table-scoped values", () => {
    expect(readActiveRuntime('# runtime = "docker"\n')).toBeUndefined();
    expect(readActiveRuntime('runtime = "foo"\n')).toBeUndefined();
    expect(readActiveRuntime('[table]\nruntime = "docker"\n')).toBeUndefined();
  });
});
