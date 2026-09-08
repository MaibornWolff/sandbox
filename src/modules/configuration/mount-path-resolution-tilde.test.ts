import { describe, expect, it } from "bun:test";
import { expandTildeInMount as expandTildeInMountWithHome } from "./mount-path-resolution.js";

const CONTAINER_HOME = "/home/sandbox";
const hostHome = "/host/home";
const expandTildeInMount = (mount: string): string =>
  expandTildeInMountWithHome(mount, hostHome);

describe("expandTildeInMount", () => {
  describe("host path tilde expansion", () => {
    it("expands ~ to host home directory", () => {
      const result = expandTildeInMount("~");
      expect(result).toBe(hostHome);
    });

    it("expands ~/path to host home directory", () => {
      const result = expandTildeInMount("~/.npmrc");
      expect(result).toBe(`${hostHome}/.npmrc`);
    });

    it("expands ~/nested/path correctly", () => {
      const result = expandTildeInMount("~/.config/app");
      expect(result).toBe(`${hostHome}/.config/app`);
    });

    it("leaves absolute paths unchanged", () => {
      const result = expandTildeInMount("/absolute/path");
      expect(result).toBe("/absolute/path");
    });

    it("leaves relative paths unchanged", () => {
      const result = expandTildeInMount("./relative/path");
      expect(result).toBe("./relative/path");
    });
  });

  describe("shorthand with mode", () => {
    it("expands ~:rw shorthand", () => {
      const result = expandTildeInMount("~:rw");
      expect(result).toBe(`${hostHome}:rw`);
    });

    it("expands ~:ro shorthand", () => {
      const result = expandTildeInMount("~:ro");
      expect(result).toBe(`${hostHome}:ro`);
    });

    it("expands ~/.npmrc:rw shorthand", () => {
      const result = expandTildeInMount("~/.npmrc:rw");
      expect(result).toBe(`${hostHome}/.npmrc:rw`);
    });

    it("expands ~/.config:ro shorthand", () => {
      const result = expandTildeInMount("~/.config:ro");
      expect(result).toBe(`${hostHome}/.config:ro`);
    });
  });

  describe("container path tilde expansion", () => {
    it("expands ~ on container side to /home/sandbox", () => {
      const result = expandTildeInMount("~/.npmrc:~/.npmrc");
      expect(result).toBe(`${hostHome}/.npmrc:${CONTAINER_HOME}/.npmrc`);
    });

    it("expands ~ alone on container side", () => {
      const result = expandTildeInMount("~/data:~");
      expect(result).toBe(`${hostHome}/data:${CONTAINER_HOME}`);
    });

    it("expands nested container paths", () => {
      const result = expandTildeInMount("~/.config/app:~/.config/app");
      expect(result).toBe(
        `${hostHome}/.config/app:${CONTAINER_HOME}/.config/app`,
      );
    });
  });

  describe("full syntax with mode", () => {
    it("expands both sides with :ro mode", () => {
      const result = expandTildeInMount("~/.npmrc:~/.npmrc:ro");
      expect(result).toBe(`${hostHome}/.npmrc:${CONTAINER_HOME}/.npmrc:ro`);
    });

    it("expands both sides with :rw mode", () => {
      const result = expandTildeInMount("~/.config:~/.config:rw");
      expect(result).toBe(`${hostHome}/.config:${CONTAINER_HOME}/.config:rw`);
    });
  });

  describe("mixed paths", () => {
    it("expands host ~ with absolute container path", () => {
      const result = expandTildeInMount("~/.npmrc:/etc/npmrc");
      expect(result).toBe(`${hostHome}/.npmrc:/etc/npmrc`);
    });

    it("expands host ~ with absolute container path and mode", () => {
      const result = expandTildeInMount("~/.npmrc:/etc/npmrc:ro");
      expect(result).toBe(`${hostHome}/.npmrc:/etc/npmrc:ro`);
    });

    it("leaves absolute host path with ~ container path", () => {
      const result = expandTildeInMount("/host/data:~/.data");
      expect(result).toBe(`/host/data:${CONTAINER_HOME}/.data`);
    });

    it("handles absolute host with absolute container", () => {
      const result = expandTildeInMount("/host/path:/container/path:rw");
      expect(result).toBe("/host/path:/container/path:rw");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      const result = expandTildeInMount("");
      expect(result).toBe("");
    });

    it("handles path starting with ~username (not expanded)", () => {
      // ~username is a different tilde expansion pattern that we don't support
      const result = expandTildeInMount("~user/.npmrc");
      expect(result).toBe("~user/.npmrc");
    });

    it("handles tilde in middle of path (not expanded)", () => {
      const result = expandTildeInMount("/path/to/~/file");
      expect(result).toBe("/path/to/~/file");
    });
  });

  describe("Windows paths", () => {
    it("leaves Windows absolute path unchanged", () => {
      const result = expandTildeInMount("C:\\Users\\foo\\.npmrc");
      expect(result).toBe("C:\\Users\\foo\\.npmrc");
    });

    it("handles Windows path with container destination", () => {
      const result = expandTildeInMount("C:\\Users\\foo\\data:/data:rw");
      expect(result).toBe("C:\\Users\\foo\\data:/data:rw");
    });

    it("handles Windows path with tilde container destination", () => {
      const result = expandTildeInMount("C:\\Users\\foo\\data:~/.data:ro");
      expect(result).toBe(`C:\\Users\\foo\\data:${CONTAINER_HOME}/.data:ro`);
    });

    it("handles lowercase Windows drive letter", () => {
      const result = expandTildeInMount("c:\\data:/data:rw");
      expect(result).toBe("c:\\data:/data:rw");
    });
  });

  describe("Windows forward slash paths (bug reproduction)", () => {
    // BUG: Paths like "C:/Users/foo" from Git on Windows are not handled correctly
    // The regex only matches "C:\" (backslash), not "C:/" (forward slash)

    it("handles C:/ format with container destination", () => {
      expect(expandTildeInMount("C:/Users/foo/data:/data:rw")).toBe(
        "C:/Users/foo/data:/data:rw",
      );
    });

    it("handles C:/ with tilde container path", () => {
      expect(expandTildeInMount("C:/data:~/.data:ro")).toBe(
        `C:/data:${CONTAINER_HOME}/.data:ro`,
      );
    });

    it("handles C:/ with spaces", () => {
      expect(expandTildeInMount("C:/Program Files/App:/app:ro")).toBe(
        "C:/Program Files/App:/app:ro",
      );
    });
  });
});
