import type { ManagedContainer } from "#platform/container-runtime/__test__/index.js";
import {
  buildContainerDiagnosticCommand,
  buildContainerNetworkStateCommand,
  type NetworkDiagnosticSource,
} from "../container-diagnostic-commands.js";

export interface NetworkObservationFixture {
  block(host: string, port: number): void;
  allow(host: string, port: number): void;
  blockIp(ip: string, port: number): void;
  resolve(host: string, ip: string): void;
  malformed(source: NetworkDiagnosticSource, line: string): void;
  givenNetworkState(output: string): void;
  givenProxyCache(output: string): void;
  givenRuntimeLogs(output: string | Error): void;
  fail(source: NetworkDiagnosticSource | "state", error: Error): void;
}

export function createNetworkObservationFixture(
  container: ManagedContainer,
): NetworkObservationFixture {
  const logs: Record<NetworkDiagnosticSource, string[]> = {
    firewall: [],
    dns: [],
    "proxy-access": [],
    "proxy-cache": [],
  };
  let networkState = "";

  function update(source: NetworkDiagnosticSource): void {
    container.givenExecResult(
      buildContainerDiagnosticCommand(source),
      logs[source].join("\n"),
    );
  }
  function updateState(): void {
    container.givenExecResult(
      buildContainerNetworkStateCommand(),
      networkState,
    );
  }
  for (const source of Object.keys(logs) as NetworkDiagnosticSource[]) {
    update(source);
  }
  updateState();

  return {
    block(host, port) {
      if (port === 0) {
        logs.dns.push(
          `Jan 1 00:00:00 dnsmasq[123]: config ${host} is NXDOMAIN`,
        );
        update("dns");
      } else {
        logs["proxy-access"].push(
          `1767225600.000 0 127.0.0.1 TCP_DENIED/403 3456 CONNECT ${host}:${port} - HIER_NONE/- text/html`,
        );
        update("proxy-access");
      }
    },
    allow(host, port) {
      logs["proxy-access"].push(
        `1767225600.000 1 127.0.0.1 TCP_TUNNEL/200 100 CONNECT ${host}:${port} - HIER_DIRECT/1.2.3.4 -`,
      );
      update("proxy-access");
    },
    blockIp(ip, port) {
      logs.firewall.push(
        `1767225600.000000 IP 192.168.0.2.50000 > ${ip}.${port}: Flags [S]`,
      );
      update("firewall");
    },
    resolve(host, ip) {
      logs.dns.push(`Jan 1 00:00:00 dnsmasq[123]: reply ${host} is ${ip}`);
      update("dns");
    },
    malformed(source, line) {
      logs[source].push(line);
      update(source);
    },
    givenNetworkState(output) {
      networkState = output;
      updateState();
    },
    givenProxyCache(output) {
      logs["proxy-cache"] = [output];
      update("proxy-cache");
    },
    givenRuntimeLogs(output) {
      container.givenLogs(output);
    },
    fail(source, error) {
      container.givenExecResult(
        source === "state"
          ? buildContainerNetworkStateCommand()
          : buildContainerDiagnosticCommand(source),
        error,
      );
    },
  };
}
