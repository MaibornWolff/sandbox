import { describe, expect, test } from "bun:test";
import {
  parseAllowedNetwork,
  parseMount,
  parsePort,
} from "./config-value-parsing.js";

describe("parseMount", () => {
  test("shorthand: /path -> /path:/path:ro", async () => {
    expect(parseMount("/tmp")).toBe("/tmp:/tmp:ro");
  });

  test("shorthand rw: /path:rw -> /path:/path:rw", async () => {
    expect(parseMount("/tmp:rw")).toBe("/tmp:/tmp:rw");
  });

  test("shorthand ro: /path:ro -> /path:/path:ro", async () => {
    expect(parseMount("/data:ro")).toBe("/data:/data:ro");
  });

  test("shorthand with tilde: ~/data:rw -> ~/data:~/data:rw", async () => {
    expect(parseMount("~/data:rw")).toBe("~/data:~/data:rw");
  });

  test("shorthand with relative path: ./output:rw -> ./output:./output:rw", async () => {
    expect(parseMount("./output:rw")).toBe("./output:./output:rw");
  });

  test("destination: /src:/dst -> /src:/dst:ro", async () => {
    expect(parseMount("/src:/dst")).toBe("/src:/dst:ro");
  });

  test("explicit rw: /src:/dst:rw -> /src:/dst:rw", async () => {
    expect(parseMount("/src:/dst:rw")).toBe("/src:/dst:rw");
  });

  test("explicit ro: /src:/dst:ro -> /src:/dst:ro", async () => {
    expect(parseMount("/src:/dst:ro")).toBe("/src:/dst:ro");
  });

  test("complex path with spaces", async () => {
    expect(parseMount("/path with spaces:/dest")).toBe(
      "/path with spaces:/dest:ro",
    );
  });

  test("directory named 'rw' needs explicit path syntax", async () => {
    // User wants to mount /src to a directory named "rw"
    // Must use /src:/data/rw (not /src:rw which would be interpreted as mode)
    expect(parseMount("/src:/data/rw")).toBe("/src:/data/rw:ro");
  });
});

describe("parseMount - Windows paths", () => {
  test("derives a POSIX destination for Windows shorthand", () => {
    expect(parseMount("C:\\Users\\foo")).toBe(
      "C:\\Users\\foo:/mnt/c/Users/foo:ro",
    );
  });

  test("derives a POSIX destination for Windows shorthand with mode", () => {
    expect(parseMount("C:\\Users\\foo:rw")).toBe(
      "C:\\Users\\foo:/mnt/c/Users/foo:rw",
    );
    expect(parseMount("C:\\Users\\foo:ro")).toBe(
      "C:\\Users\\foo:/mnt/c/Users/foo:ro",
    );
  });

  test("Windows to Linux path: C:\\data:/container -> C:\\data:/container:ro", async () => {
    expect(parseMount("C:\\data:/container")).toBe("C:\\data:/container:ro");
  });

  test("Windows to Linux path with mode: C:\\data:/container:rw -> C:\\data:/container:rw", async () => {
    expect(parseMount("C:\\data:/container:rw")).toBe("C:\\data:/container:rw");
  });

  test("Windows path with lowercase drive: d:\\projects:/app:rw -> d:\\projects:/app:rw", async () => {
    expect(parseMount("d:\\projects:/app:rw")).toBe("d:\\projects:/app:rw");
  });

  test("preserves spaces in a derived Windows destination", () => {
    expect(parseMount("C:\\Program Files\\App")).toBe(
      "C:\\Program Files\\App:/mnt/c/Program Files/App:ro",
    );
  });

  test("Windows UNC paths are not affected: \\\\server\\share:/data:ro -> \\\\server\\share:/data:ro", async () => {
    // UNC paths don't start with drive letters, so they use regular colon splitting
    expect(parseMount("\\\\server\\share:/data:ro")).toBe(
      "\\\\server\\share:/data:ro",
    );
  });
});

describe("parseMount - Windows forward slash paths", () => {
  test("derives a POSIX destination for shorthand", () => {
    expect(parseMount("C:/Users/foo")).toBe("C:/Users/foo:/mnt/c/Users/foo:ro");
  });

  test("derives a POSIX destination for shorthand with mode", () => {
    expect(parseMount("C:/Users/foo:rw")).toBe(
      "C:/Users/foo:/mnt/c/Users/foo:rw",
    );
  });

  test("handles C:/ to container path", () => {
    expect(parseMount("C:/data:/container:rw")).toBe("C:/data:/container:rw");
  });

  test("preserves spaces in a derived destination", () => {
    expect(parseMount("C:/projects/20 - LoKeyFlow/app")).toBe(
      "C:/projects/20 - LoKeyFlow/app:/mnt/c/projects/20 - LoKeyFlow/app:ro",
    );
  });
});

describe("parsePort", () => {
  test("shorthand: 8080 -> 8080:8080", async () => {
    expect(parsePort("8080")).toBe("8080:8080");
  });

  test("host:container: 8080:3000 -> 8080:3000", async () => {
    expect(parsePort("8080:3000")).toBe("8080:3000");
  });

  test("bind:host:container: 127.0.0.1:8080:3000 -> 127.0.0.1:8080:3000", async () => {
    expect(parsePort("127.0.0.1:8080:3000")).toBe("127.0.0.1:8080:3000");
  });

  test("shorthand with single port 3000", async () => {
    expect(parsePort("3000")).toBe("3000:3000");
  });

  test("different ports: 9000:8080", async () => {
    expect(parsePort("9000:8080")).toBe("9000:8080");
  });

  test("IPv6 localhost: [::1]:8080:3000", async () => {
    expect(parsePort("[::1]:8080:3000")).toBe("[::1]:8080:3000");
  });

  test("specific interface: 192.168.1.1:8080:3000", async () => {
    expect(parsePort("192.168.1.1:8080:3000")).toBe("192.168.1.1:8080:3000");
  });
});

describe("parseAllowedNetwork", () => {
  test("host only: github.com -> default ports 80, 443", async () => {
    expect(parseAllowedNetwork("github.com")).toEqual({
      host: "github.com",
      ports: [80, 443],
      wildcard: false,
    });
  });

  test("single port: github.com:443", async () => {
    expect(parseAllowedNetwork("github.com:443")).toEqual({
      host: "github.com",
      ports: [443],
      wildcard: false,
    });
  });

  test("single port: github.com:22", async () => {
    expect(parseAllowedNetwork("github.com:22")).toEqual({
      host: "github.com",
      ports: [22],
      wildcard: false,
    });
  });

  test("multiple ports: github.com:{22,443}", async () => {
    expect(parseAllowedNetwork("github.com:{22,443}")).toEqual({
      host: "github.com",
      ports: [22, 443],
      wildcard: false,
    });
  });

  test("multiple ports with spaces: api.example.com:{80, 443, 8080}", async () => {
    expect(parseAllowedNetwork("api.example.com:{80, 443, 8080}")).toEqual({
      host: "api.example.com",
      ports: [80, 443, 8080],
      wildcard: false,
    });
  });

  test("subdomain: api.anthropic.com", async () => {
    expect(parseAllowedNetwork("api.anthropic.com")).toEqual({
      host: "api.anthropic.com",
      ports: [80, 443],
      wildcard: false,
    });
  });

  test("port 8080: localhost:8080", async () => {
    expect(parseAllowedNetwork("localhost:8080")).toEqual({
      host: "localhost",
      ports: [8080],
      wildcard: false,
    });
  });

  test("wildcard: *.githubusercontent.com -> default ports, wildcard true", async () => {
    expect(parseAllowedNetwork("*.githubusercontent.com")).toEqual({
      host: "githubusercontent.com",
      ports: [80, 443],
      wildcard: true,
    });
  });

  test("wildcard with port: *.example.com:443", async () => {
    expect(parseAllowedNetwork("*.example.com:443")).toEqual({
      host: "example.com",
      ports: [443],
      wildcard: true,
    });
  });

  test("wildcard with multiple ports: *.example.com:{80,443}", async () => {
    expect(parseAllowedNetwork("*.example.com:{80,443}")).toEqual({
      host: "example.com",
      ports: [80, 443],
      wildcard: true,
    });
  });

  for (const value of ["example.com:*", "example.com:{*}"]) {
    test(`all ports: ${value}`, () => {
      expect(parseAllowedNetwork(value)).toEqual({
        host: "example.com",
        ports: "*",
        wildcard: false,
      });
    });
  }

  for (const value of ["*.example.com:*", "*.example.com:{*}"]) {
    test(`wildcard host with all ports: ${value}`, () => {
      expect(parseAllowedNetwork(value)).toEqual({
        host: "example.com",
        ports: "*",
        wildcard: true,
      });
    });
  }

  for (const value of [
    "example.com:{443,*}",
    "example.com:{*,443}",
    "example.com:{*,*}",
  ]) {
    test(`rejects mixed wildcard port set: ${value}`, () => {
      expect(() => parseAllowedNetwork(value)).toThrow(
        `Invalid wildcard port set in '${value}': '*' must be the only port`,
      );
    });
  }

  test("error: mid-string wildcard", async () => {
    expect(() => parseAllowedNetwork("foo.*.com")).toThrow("Invalid wildcard");
  });

  test("error: trailing wildcard", async () => {
    expect(() => parseAllowedNetwork("foo.com.*")).toThrow("Invalid wildcard");
  });

  test("error: invalid port number", async () => {
    expect(() => parseAllowedNetwork("github.com:invalid")).toThrow(
      "Invalid port number",
    );
  });

  test("error: port out of range (too high)", async () => {
    expect(() => parseAllowedNetwork("github.com:99999")).toThrow(
      "Invalid port number",
    );
  });

  test("error: port out of range (zero)", async () => {
    expect(() => parseAllowedNetwork("github.com:0")).toThrow(
      "Invalid port number",
    );
  });

  test("error: empty port list", async () => {
    expect(() => parseAllowedNetwork("github.com:{}")).toThrow(
      "Empty port list",
    );
  });

  test("error: invalid port in list", async () => {
    expect(() => parseAllowedNetwork("github.com:{22,invalid}")).toThrow(
      "Invalid port number",
    );
  });

  test("single port in braces: github.com:{443}", async () => {
    expect(parseAllowedNetwork("github.com:{443}")).toEqual({
      host: "github.com",
      ports: [443],
      wildcard: false,
    });
  });
});
