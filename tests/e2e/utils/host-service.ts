import { createServer } from "node:http";

function getE2eHostName(): string {
  if (process.env.SANDBOX_TEST_RUNTIME === "podman")
    return "host.containers.internal";
  if (process.env.SANDBOX_TEST_RUNTIME === "apple-container")
    return "host.container.internal";
  return "host.docker.internal";
}

export async function createHostService() {
  const requests: { method: string; path: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("controlled-host-service\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Host service did not allocate a port");
  return {
    hostName: getE2eHostName(),
    port: address.port,
    requests,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
