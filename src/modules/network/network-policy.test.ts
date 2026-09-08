import { describe, expect, test } from "bun:test";
import { createConfigFromDefaults } from "#modules/configuration/index.js";
import { normalizeNetworkPolicy } from "./network-policy.js";

describe("normalizeNetworkPolicy", () => {
  test("creates the normalized host and container network contract", () => {
    const config = createConfigFromDefaults("docker", {
      allowNetwork: [{ host: "example.com", ports: [443], wildcard: false }],
      fullNetwork: true,
      noProxy: true,
    });

    expect(normalizeNetworkPolicy(config)).toEqual({
      enabled: true,
      allowNetwork: [{ host: "example.com", ports: [443], wildcard: false }],
      fullNetwork: true,
      noProxy: true,
    });
  });
});
