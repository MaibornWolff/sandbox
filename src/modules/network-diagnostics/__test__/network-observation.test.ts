import { describe, expect, test } from "bun:test";
import { createStatefulContainerRuntimeHarness } from "#platform/container-runtime/__test__/index.js";
import { collectContainerEntries } from "../network-log-collection.js";
import { createNetworkObservationFixture } from "./index.js";

describe("network observation fixture", () => {
  test("translates blocked domains into production diagnostic logs", async () => {
    const harness = createStatefulContainerRuntimeHarness();
    const container = harness.containers.create({
      name: "sandbox-project",
      image: "sandbox-project:latest",
      labels: {},
      status: "running",
    });
    const observations = createNetworkObservationFixture(container);
    observations.block("api.example.com", 443);
    observations.block("dns.example.com", 0);
    const runtime = await harness.provider.resolve();

    const entries = await collectContainerEntries(
      runtime,
      {
        id: container.id,
        name: "sandbox-project",
        image: "sandbox-project:latest",
      },
      true,
      Date.UTC(2026, 0, 1),
    );

    expect(
      entries.map(({ destination, port, status }) => ({
        destination,
        port,
        status,
      })),
    ).toEqual([
      { destination: "api.example.com", port: 443, status: "BLOCKED" },
      { destination: "dns.example.com", port: 0, status: "BLOCKED" },
    ]);
  });
});
