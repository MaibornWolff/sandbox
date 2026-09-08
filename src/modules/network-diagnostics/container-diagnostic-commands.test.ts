import { describe, expect, test } from "bun:test";
import {
  buildContainerDiagnosticCommand,
  buildContainerNetworkStateCommand,
} from "./container-diagnostic-commands.js";

describe("container network diagnostic commands", () => {
  test("uses the stable container-tools command for each log source", () => {
    expect(buildContainerDiagnosticCommand("firewall")).toEqual([
      "/usr/local/bin/sandbox-container-tools",
      "network",
      "diagnostic",
      "firewall",
    ]);
    expect(buildContainerDiagnosticCommand("proxy-cache")).toEqual([
      "/usr/local/bin/sandbox-container-tools",
      "network",
      "diagnostic",
      "proxy-cache",
    ]);
  });

  test("uses the stable container-tools state command", () => {
    expect(buildContainerNetworkStateCommand()).toEqual([
      "/usr/local/bin/sandbox-container-tools",
      "network",
      "state",
    ]);
  });
});
