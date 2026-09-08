import { describe, expect, test } from "bun:test";
import { createStatefulTcpService } from "./stateful-tcp-service.js";

describe("stateful TCP service", () => {
  test("rejects connection attempts after its public fixture is disposed", async () => {
    const tcp = createStatefulTcpService();
    await tcp.dispose();

    await expect(
      tcp.service.canConnect(
        { host: "127.0.0.1", port: 8080 },
        { timeoutMilliseconds: 1_000 },
      ),
    ).rejects.toMatchObject({
      name: "AbortError",
      message: "The stateful TCP service was disposed",
    });
  });
});
