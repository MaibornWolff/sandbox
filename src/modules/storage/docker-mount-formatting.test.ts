import { describe, expect, it } from "bun:test";
import { mountToDockerArg } from "./docker-mount-formatting.js";

describe("mountToDockerArg", () => {
  it("formats mount with read-write mode", () => {
    const result = mountToDockerArg({
      hostPath: "/home/user/.config",
      containerPath: "/home/sandbox/.config",
      mode: "rw",
    });

    expect(result).toBe("/home/user/.config:/home/sandbox/.config:rw");
  });

  it("formats mount with read-only mode", () => {
    const result = mountToDockerArg({
      hostPath: "/data/shared",
      containerPath: "/mnt/data",
      mode: "ro",
    });

    expect(result).toBe("/data/shared:/mnt/data:ro");
  });

  it("converts Windows host paths", () => {
    const result = mountToDockerArg({
      hostPath: "C:\\Users\\tester\\AppData\\Local\\sandbox\\runtime",
      containerPath: "/opt/sandbox-cli",
      mode: "ro",
    });

    expect(result).toBe(
      "/mnt/c/Users/tester/AppData/Local/sandbox/runtime:/opt/sandbox-cli:ro",
    );
  });

  it("handles paths with special characters", () => {
    const result = mountToDockerArg({
      hostPath: "/home/user/my project",
      containerPath: "/workspace/my project",
      mode: "rw",
    });

    expect(result).toBe("/home/user/my project:/workspace/my project:rw");
  });
});
