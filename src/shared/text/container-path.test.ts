import { describe, expect, test } from "bun:test";
import { resolveContainerPath } from "./container-path.js";

describe("resolveContainerPath", () => {
  test("expands home-relative paths", () => {
    expect(resolveContainerPath("~", "/home/sandbox")).toBe("/home/sandbox");
    expect(resolveContainerPath("~/.config", "/home/sandbox")).toBe(
      "/home/sandbox/.config",
    );
  });

  test("resolves relative paths against the container home", () => {
    expect(resolveContainerPath("./file.txt", "/home/sandbox")).toBe(
      "/home/sandbox/file.txt",
    );
    expect(resolveContainerPath("../file.txt", "/home/user")).toBe(
      "/home/file.txt",
    );
  });

  test("normalizes absolute paths", () => {
    expect(resolveContainerPath("/etc/../var/config", "/home/sandbox")).toBe(
      "/var/config",
    );
  });
});
