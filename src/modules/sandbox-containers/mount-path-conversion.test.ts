import { describe, expect, test } from "bun:test";
import { convertMountForDocker } from "./mount-path-conversion.js";

describe("convertMountForDocker", () => {
  test("keeps Unix mounts unchanged", () => {
    expect(convertMountForDocker("/home/user:/data:ro")).toBe(
      "/home/user:/data:ro",
    );
  });

  test("converts Windows host paths", () => {
    expect(convertMountForDocker("C:\\Users\\foo:/data:ro")).toBe(
      "/mnt/c/Users/foo:/data:ro",
    );
    expect(convertMountForDocker("C:/Users/foo:/data:rw")).toBe(
      "/mnt/c/Users/foo:/data:rw",
    );
  });
});
