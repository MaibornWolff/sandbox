import type { ManagedContainer } from "#platform/container-runtime/__test__/index.js";
import {
  type ContainerLogSource,
  serializeContainerLogBundle,
} from "#platform/container-system/index.js";
import {
  buildContainerDiagnosticBundleCommand,
  buildContainerNetworkStateCommand,
} from "../container-diagnostic-commands.js";

export interface NetworkObservationFixture {
  block(host: string, port: number): void;
  allow(host: string, port: number): void;
  blockIp(ip: string, port: number): void;
  resolve(host: string, ip: string): void;
  malformed(source: ContainerLogSource, line: string): void;
  givenNetworkState(output: string): void;
  givenProxyCache(output: string): void;
  givenRuntimeLogs(output: string | Error): void;
  fail(source: "logs" | "state", error: Error): void;
}

export function createNetworkObservationFixture(
  container: ManagedContainer,
): NetworkObservationFixture {
  const logs: Record<ContainerLogSource, string[]> = {
    firewall: [],
    dns: [],
    "proxy-access": [],
    "proxy-cache": [],
  };
  let networkState = "";

  function update(): void {
    container.givenExecResult(
      buildContainerDiagnosticBundleCommand(),
      serializeContainerLogBundle({
        firewall: logs.firewall.join("\n"),
        dns: logs.dns.join("\n"),
        "proxy-access": logs["proxy-access"].join("\n"),
        "proxy-cache": logs["proxy-cache"].join("\n"),
      }),
    );
  }
  function updateState(): void {
    container.givenExecResult(
      buildContainerNetworkStateCommand(),
      networkState,
    );
  }
  update();
  updateState();

  return {
    block(host, port) {
      if (port === 0) {
        logs.dns.push(
          `Jan 1 00:00:00 dnsmasq[123]: config ${host} is NXDOMAIN`,
        );
      } else {
        logs["proxy-access"].push(
          `1767225600.000 0 127.0.0.1 TCP_DENIED/403 3456 CONNECT ${host}:${port} - HIER_NONE/- text/html`,
        );
      }
      update();
    },
    allow(host, port) {
      logs["proxy-access"].push(
        `1767225600.000 1 127.0.0.1 TCP_TUNNEL/200 100 CONNECT ${host}:${port} - HIER_DIRECT/1.2.3.4 -`,
      );
      update();
    },
    blockIp(ip, port) {
      logs.firewall.push(
        `1767225600.000000 IP 192.168.0.2.50000 > ${ip}.${port}: Flags [S]`,
      );
      update();
    },
    resolve(host, ip) {
      logs.dns.push(`Jan 1 00:00:00 dnsmasq[123]: reply ${host} is ${ip}`);
      update();
    },
    malformed(source, line) {
      logs[source].push(line);
      update();
    },
    givenNetworkState(output) {
      networkState = output;
      updateState();
    },
    givenProxyCache(output) {
      logs["proxy-cache"] = [output];
      update();
    },
    givenRuntimeLogs(output) {
      container.givenLogs(output);
    },
    fail(source, error) {
      container.givenExecResult(
        source === "state"
          ? buildContainerNetworkStateCommand()
          : buildContainerDiagnosticBundleCommand(),
        error,
      );
    },
  };
}
