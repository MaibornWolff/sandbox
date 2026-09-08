import * as net from "node:net";
import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";

export interface TcpEndpoint {
  readonly host: string;
  readonly port: number;
}

export interface TcpService {
  canConnect(
    endpoint: TcpEndpoint,
    options: {
      readonly timeoutMilliseconds: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<boolean>;
}

const tcpServiceDependency = createDependency<TcpService>("TCP service");

export function provideTcpService(service: TcpService): DependencyBinding {
  return tcpServiceDependency.provide(service);
}

export function getTcpService(): TcpService {
  return tcpServiceDependency.get();
}

export function createNodeTcpService(): TcpService {
  return {
    canConnect(endpoint, options) {
      if (options.signal?.aborted) return Promise.resolve(false);
      return new Promise((resolve) => {
        const socket = net.createConnection(endpoint);
        if (options.timeoutMilliseconds <= 0) {
          socket.destroy();
          resolve(false);
          return;
        }
        let settled = false;
        let timeout: NodeJS.Timeout;
        const finish = (connected: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", onFailure);
          socket.removeAllListeners();
          socket.destroy();
          resolve(connected);
        };
        const onFailure = () => finish(false);
        const onConnect = () => finish(true);
        timeout = setTimeout(onFailure, options.timeoutMilliseconds);
        socket.once("connect", onConnect);
        socket.once("error", onFailure);
        options.signal?.addEventListener("abort", onFailure, { once: true });
      });
    },
  };
}
