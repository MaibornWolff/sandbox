import type { TcpEndpoint, TcpService } from "../tcp-service.js";

export interface TcpConnectionAttempt {
  readonly endpoint: TcpEndpoint;
  readonly timeoutMilliseconds: number;
}

export interface StatefulTcpService {
  readonly service: TcpService;
  givenListening(endpoint: TcpEndpoint): void;
  givenClosed(endpoint: TcpEndpoint): void;
  givenFailure(endpoint: TcpEndpoint, error: Error): void;
  attempts(): readonly TcpConnectionAttempt[];
  openSockets(): readonly TcpEndpoint[];
  dispose(): Promise<void>;
}

type EndpointState =
  | { readonly kind: "listening" }
  | { readonly kind: "closed" }
  | { readonly kind: "failure"; readonly error: Error };

function endpointKey(endpoint: TcpEndpoint): string {
  return `${endpoint.host}:${endpoint.port}`;
}

export function createStatefulTcpService(): StatefulTcpService {
  const states = new Map<string, EndpointState>();
  const endpoints = new Map<string, TcpEndpoint>();
  const attempts: TcpConnectionAttempt[] = [];
  let disposed = false;

  function setState(endpoint: TcpEndpoint, state: EndpointState): void {
    const key = endpointKey(endpoint);
    endpoints.set(key, { ...endpoint });
    states.set(key, state);
  }

  return {
    service: {
      async canConnect(endpoint, options) {
        if (disposed) {
          throw new DOMException(
            "The stateful TCP service was disposed",
            "AbortError",
          );
        }
        attempts.push({
          endpoint: { ...endpoint },
          timeoutMilliseconds: options.timeoutMilliseconds,
        });
        if (options.signal?.aborted) return false;
        const state = states.get(endpointKey(endpoint));
        if (state?.kind === "failure") throw state.error;
        return state?.kind === "listening";
      },
    },
    givenListening(endpoint) {
      setState(endpoint, { kind: "listening" });
    },
    givenClosed(endpoint) {
      setState(endpoint, { kind: "closed" });
    },
    givenFailure(endpoint, error) {
      setState(endpoint, { kind: "failure", error });
    },
    attempts: () =>
      attempts.map((attempt) => ({
        ...attempt,
        endpoint: { ...attempt.endpoint },
      })),
    openSockets: () =>
      [...states.entries()]
        .filter(([, state]) => state.kind === "listening")
        .map(([key]) => ({ ...(endpoints.get(key) as TcpEndpoint) })),
    async dispose() {
      if (disposed) return;
      disposed = true;
      states.clear();
      endpoints.clear();
      await Promise.resolve();
    },
  };
}
