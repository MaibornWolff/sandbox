import { describe, expect, test } from "bun:test";
import { splitColonString } from "./index.js";
import {
  hasNormalizedPathSegments,
  isAbsolutePath,
  isWindowsDrivePath,
  normalizePath,
  parseWindowsDrivePath,
  safeResolve,
  windowsPathToDocker,
} from "./path.js";

describe("normalizePath", () => {
  test("converts backslashes to forward slashes", () => {
    expect(normalizePath("C:\\Users\\foo")).toBe("C:/Users/foo");
  });

  test("leaves forward slashes unchanged", () => {
    expect(normalizePath("C:/Users/foo")).toBe("C:/Users/foo");
  });

  test("leaves Unix paths unchanged", () => {
    expect(normalizePath("/home/user/project")).toBe("/home/user/project");
  });

  test("handles mixed separators", () => {
    expect(normalizePath("C:\\Users/foo\\bar/baz")).toBe(
      "C:/Users/foo/bar/baz",
    );
  });

  test("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  test("handles Windows drive paths with backslashes", () => {
    expect(normalizePath("D:\\Development\\myproject")).toBe(
      "D:/Development/myproject",
    );
  });
});

describe("isWindowsDrivePath", () => {
  test("returns true for backslash format", () => {
    expect(isWindowsDrivePath("C:\\Users\\foo")).toBe(true);
    expect(isWindowsDrivePath("D:\\data")).toBe(true);
  });

  test("returns true for forward slash format", () => {
    expect(isWindowsDrivePath("C:/Users/foo")).toBe(true);
    expect(isWindowsDrivePath("D:/data")).toBe(true);
  });

  test("returns true for lowercase drive letters", () => {
    expect(isWindowsDrivePath("c:\\Users")).toBe(true);
    expect(isWindowsDrivePath("c:/Users")).toBe(true);
  });

  test("returns false for Unix paths", () => {
    expect(isWindowsDrivePath("/home/user")).toBe(false);
    expect(isWindowsDrivePath("/mnt/c/Users")).toBe(false);
  });

  test("returns false for relative paths", () => {
    expect(isWindowsDrivePath("./relative")).toBe(false);
    expect(isWindowsDrivePath("../parent")).toBe(false);
  });

  test("returns false for drive letter without separator", () => {
    expect(isWindowsDrivePath("C:file")).toBe(false);
    expect(isWindowsDrivePath("C:")).toBe(false);
  });
});

describe("parseWindowsDrivePath", () => {
  test("parses backslash format", () => {
    expect(parseWindowsDrivePath("C:\\Users\\foo")).toEqual({
      driveLetter: "c",
      pathAfterDrive: "Users/foo",
    });
  });

  test("parses forward slash format", () => {
    expect(parseWindowsDrivePath("C:/Users/foo")).toEqual({
      driveLetter: "c",
      pathAfterDrive: "Users/foo",
    });
  });

  test("normalizes backslashes in path", () => {
    expect(parseWindowsDrivePath("C:\\Users\\foo\\bar")).toEqual({
      driveLetter: "c",
      pathAfterDrive: "Users/foo/bar",
    });
  });

  test("handles lowercase drive letter", () => {
    expect(parseWindowsDrivePath("d:/data")).toEqual({
      driveLetter: "d",
      pathAfterDrive: "data",
    });
  });

  test("handles paths with spaces", () => {
    expect(parseWindowsDrivePath("C:/Program Files/App")).toEqual({
      driveLetter: "c",
      pathAfterDrive: "Program Files/App",
    });
    expect(parseWindowsDrivePath("C:/projects/20 - LoKeyFlow/src")).toEqual({
      driveLetter: "c",
      pathAfterDrive: "projects/20 - LoKeyFlow/src",
    });
  });

  test("handles root drive path", () => {
    expect(parseWindowsDrivePath("C:/")).toEqual({
      driveLetter: "c",
      pathAfterDrive: "",
    });
  });

  test("returns null for Unix paths", () => {
    expect(parseWindowsDrivePath("/home/user")).toBeNull();
  });

  test("returns null for relative paths", () => {
    expect(parseWindowsDrivePath("./relative")).toBeNull();
  });

  test("returns null for drive letter without separator", () => {
    expect(parseWindowsDrivePath("C:file")).toBeNull();
  });
});

describe("windowsPathToDocker", () => {
  test("converts backslash format to WSL mount path", () => {
    expect(windowsPathToDocker("C:\\Users\\foo")).toBe("/mnt/c/Users/foo");
    expect(windowsPathToDocker("D:\\data\\project")).toBe(
      "/mnt/d/data/project",
    );
  });

  test("converts forward slash format to WSL mount path", () => {
    expect(windowsPathToDocker("C:/Users/foo")).toBe("/mnt/c/Users/foo");
    expect(windowsPathToDocker("D:/data/project")).toBe("/mnt/d/data/project");
  });

  test("handles paths with spaces", () => {
    expect(windowsPathToDocker("C:/Program Files/App")).toBe(
      "/mnt/c/Program Files/App",
    );
    expect(windowsPathToDocker("C:/projects/20 - LoKeyFlow/src")).toBe(
      "/mnt/c/projects/20 - LoKeyFlow/src",
    );
  });

  test("handles lowercase drive letters", () => {
    expect(windowsPathToDocker("c:/users/foo")).toBe("/mnt/c/users/foo");
  });

  test("returns Unix paths unchanged", () => {
    expect(windowsPathToDocker("/home/user")).toBe("/home/user");
  });

  test("normalizes backslashes in non-drive paths", () => {
    expect(windowsPathToDocker("relative\\path")).toBe("relative/path");
  });
});

describe("isAbsolutePath", () => {
  test("detects Unix absolute paths", () => {
    expect(isAbsolutePath("/usr/bin")).toBe(true);
    expect(isAbsolutePath("/")).toBe(true);
    expect(isAbsolutePath("/home/user/file.txt")).toBe(true);
  });

  test("detects Windows paths with forward slashes", () => {
    expect(isAbsolutePath("C:/Users/foo")).toBe(true);
    expect(isAbsolutePath("D:/data")).toBe(true);
    expect(isAbsolutePath("c:/lowercase")).toBe(true);
  });

  test("detects Windows paths with backslashes", () => {
    expect(isAbsolutePath("C:\\Users\\foo")).toBe(true);
    expect(isAbsolutePath("D:\\data")).toBe(true);
  });

  test("rejects relative paths", () => {
    expect(isAbsolutePath("./relative")).toBe(false);
    expect(isAbsolutePath("../parent")).toBe(false);
    expect(isAbsolutePath("file.txt")).toBe(false);
    expect(isAbsolutePath("subdir/file")).toBe(false);
  });

  test("rejects invalid Windows-like patterns", () => {
    expect(isAbsolutePath("C:noSlash")).toBe(false); // Missing slash after colon
    expect(isAbsolutePath("CC:/invalid")).toBe(false); // Two letters
  });
});

describe("safeResolve", () => {
  test("preserves Unix absolute paths", () => {
    expect(safeResolve("/absolute/path")).toBe("/absolute/path");
    expect(safeResolve("/absolute/path", "/base")).toBe("/absolute/path");
  });

  test("preserves Windows absolute paths with forward slashes", () => {
    expect(safeResolve("C:/Users/foo")).toBe("C:/Users/foo");
    expect(safeResolve("C:/Users/foo", "/base")).toBe("C:/Users/foo");
  });

  test("preserves Windows absolute paths with backslashes", () => {
    expect(safeResolve("C:\\Users\\foo")).toBe("C:\\Users\\foo");
    expect(safeResolve("D:\\data", "C:\\other")).toBe("D:\\data");
  });

  test("resolves relative paths against base", () => {
    const result = safeResolve("./data", "/project");
    expect(result).toContain("data");
    expect(result.startsWith("/")).toBe(true);
  });

  test("resolves relative paths against cwd when no base", () => {
    const result = safeResolve("./data");
    expect(result).toContain("data");
    expect(result.startsWith("/")).toBe(true);
  });
});

describe("splitColonString", () => {
  test("splits simple Unix paths", () => {
    expect(splitColonString("/src:/dst:ro")).toEqual(["/src", "/dst", "ro"]);
    expect(splitColonString("/path")).toEqual(["/path"]);
    expect(splitColonString("/src:/dst")).toEqual(["/src", "/dst"]);
  });

  test("handles Windows paths with forward slashes", () => {
    expect(splitColonString("C:/Users/foo")).toEqual(["C:/Users/foo"]);
    expect(splitColonString("C:/Users/foo:rw")).toEqual(["C:/Users/foo", "rw"]);
    expect(splitColonString("C:/src:/dst:ro")).toEqual([
      "C:/src",
      "/dst",
      "ro",
    ]);
  });

  test("handles Windows paths with backslashes", () => {
    expect(splitColonString("C:\\Users\\foo")).toEqual(["C:\\Users\\foo"]);
    expect(splitColonString("C:\\data:rw")).toEqual(["C:\\data", "rw"]);
    expect(splitColonString("C:\\src:/dst:ro")).toEqual([
      "C:\\src",
      "/dst",
      "ro",
    ]);
  });

  test("handles different drive letters", () => {
    expect(splitColonString("D:/data:/container:ro")).toEqual([
      "D:/data",
      "/container",
      "ro",
    ]);
    expect(splitColonString("E:\\backup")).toEqual(["E:\\backup"]);
  });

  test("handles port-like strings (not paths)", () => {
    expect(splitColonString("8080:3000")).toEqual(["8080", "3000"]);
  });
});

describe("hasNormalizedPathSegments", () => {
  test("accepts plain nested segments", () => {
    expect(hasNormalizedPathSegments(".config/sandbox/state.json")).toBe(true);
  });

  test("accepts a trailing separator after a segment", () => {
    expect(hasNormalizedPathSegments(".cache/")).toBe(true);
  });

  test("rejects an empty path", () => {
    expect(hasNormalizedPathSegments("")).toBe(false);
    expect(hasNormalizedPathSegments("/")).toBe(false);
  });

  test("rejects parent and current directory segments", () => {
    expect(hasNormalizedPathSegments("../.ssh")).toBe(false);
    expect(hasNormalizedPathSegments(".cache/../../.ssh")).toBe(false);
    expect(hasNormalizedPathSegments("./.cache")).toBe(false);
  });

  test("rejects repeated separators and backslashes", () => {
    expect(hasNormalizedPathSegments(".cache//tmp")).toBe(false);
    expect(hasNormalizedPathSegments("..\\.ssh")).toBe(false);
  });
});
