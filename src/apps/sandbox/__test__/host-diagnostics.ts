import type { ProcessTestHarness } from "#platform/process/__test__/index.js";

export interface HostDiagnosticsFixture {
  givenX11ServerAvailable(): void;
  givenXHostConfigured(): void;
  givenXQuartzInstalled(): void;
  givenXQuartzNetworkClientsEnabled(): void;
  givenWindowsXServerAvailable(): void;
  failCommand(command: string, args?: readonly string[]): void;
}

const success = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const failure = (stderr = "not found") => ({ exitCode: 1, stdout: "", stderr });

export function createHostDiagnosticsFixture(
  processes: ProcessTestHarness,
): HostDiagnosticsFixture {
  return {
    givenX11ServerAvailable() {
      processes
        .expectStart({ match: { command: "xdpyinfo", args: [] } })
        .resolveResult(success("display available"));
      processes
        .expectStart({ match: { command: "pgrep", args: ["-x", "XQuartz"] } })
        .resolveResult(success("100\n"));
    },
    givenXHostConfigured() {
      processes
        .expectStart({ match: { command: "xhost", args: [] } })
        .resolveResult(success("INET:localhost\nSI:localuser:sandbox\n"));
    },
    givenXQuartzInstalled() {
      processes
        .expectStart({ match: { command: "which", args: ["xquartz"] } })
        .resolveResult(success("/opt/X11/bin/xquartz"));
    },
    givenXQuartzNetworkClientsEnabled() {
      processes
        .expectStart({
          match: {
            command: "defaults",
            args: ["read", "org.xquartz.X11", "nolisten_tcp"],
          },
        })
        .resolveResult(success("0\n"));
      processes
        .expectStart({ match: { command: "ps", args: ["aux"] } })
        .resolveResult(success(""));
    },
    givenWindowsXServerAvailable() {
      processes
        .expectStart({
          match: {
            command: "tasklist",
            args: ["/FI", "IMAGENAME eq vcxsrv.exe"],
          },
        })
        .resolveResult(success("vcxsrv.exe 100 Console"));
      processes
        .expectStart({ match: { command: "tasklist", args: [] } })
        .resolveResult(success("vcxsrv.exe 100 Console"));
    },
    failCommand(command, args = []) {
      processes
        .expectStart({ match: { command: command, args: args } })
        .resolveResult(failure());
    },
  };
}
