import { describe, expect, it } from "bun:test";
import { isNewerVersion, parseVersion } from "./package-version.js";

describe("parseVersion", () => {
  it("parses major.minor.patch", () => {
    expect(parseVersion("1.5.3")).toEqual([1, 5, 3]);
  });

  it("parses two-part version", () => {
    expect(parseVersion("2.0")).toEqual([2, 0]);
  });

  it("parses single number", () => {
    expect(parseVersion("3")).toEqual([3]);
  });
});

describe("isNewerVersion", () => {
  it("returns true when latest is higher major", () => {
    expect(isNewerVersion("1.0.0", "2.0.0")).toBe(true);
  });

  it("returns true when latest is higher minor", () => {
    expect(isNewerVersion("1.4.0", "1.5.0")).toBe(true);
  });

  it("returns true when latest is higher patch", () => {
    expect(isNewerVersion("1.4.0", "1.4.1")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewerVersion("1.5.0", "1.5.0")).toBe(false);
  });

  it("returns false when current is newer", () => {
    expect(isNewerVersion("2.0.0", "1.5.0")).toBe(false);
  });
});
