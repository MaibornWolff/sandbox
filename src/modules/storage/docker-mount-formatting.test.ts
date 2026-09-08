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

  it("handles paths with special characters", () => {
    const result = mountToDockerArg({
      hostPath: "/home/user/my project",
      containerPath: "/workspace/my project",
      mode: "rw",
    });

    expect(result).toBe("/home/user/my project:/workspace/my project:rw");
  });
});
