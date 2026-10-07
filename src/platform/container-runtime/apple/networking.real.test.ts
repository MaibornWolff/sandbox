import { afterAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import { createSystemClock, provideClock } from "#platform/clock/index.js";
import { runWithDependencies } from "#platform/dependency-injection/index.js";
import type { RuntimeExecutor } from "../executor.js";
import { AppleNetworking } from "./networking.js";

const runAppleE2e = process.env.SANDBOX_E2E_APPLE === "1";
const networkName = `sandbox-test-${crypto.randomUUID()}`;

interface ListedResource {
  readonly id?: string;
  readonly configuration?: { readonly id?: string; readonly name?: string };
  readonly status?: {
    readonly ipv4Gateway?: string;
    readonly ipv4Subnet?: string;
    readonly ipv6Subnet?: string;
  };
}

const exec: RuntimeExecutor = (command, args = []) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

async function listNetworks(): Promise<readonly ListedResource[]> {
  return JSON.parse(
    await exec("container", ["network", "list", "--format", "json"]),
  ) as ListedResource[];
}

describe.skipIf(!runAppleE2e)("real Apple cold network adapter", () => {
  afterAll(async () => {
    const selected = (await listNetworks()).some(
      (network) =>
        network.id === networkName ||
        network.configuration?.name === networkName,
    );
    if (selected) await exec("container", ["network", "delete", networkName]);
  });

  test(
    "creates an absent selected network and retains it after preparation ends",
    async () =>
      runWithDependencies([provideClock(createSystemClock())], async () => {
        expect(
          (await listNetworks()).some(
            (network) =>
              network.id === networkName ||
              network.configuration?.name === networkName,
          ),
        ).toBe(false);
        const networking = new AppleNetworking(
          exec,
          { dns: "default" },
          networkName,
        );

        {
          await using plan = await networking.prepareRun();
          expect(plan.networkName).toBe(networkName);
          const selected = (await listNetworks()).find(
            (network) =>
              network.id === networkName ||
              network.configuration?.name === networkName,
          );
          expect(selected?.status).toMatchObject({
            ipv4Gateway: expect.any(String),
            ipv4Subnet: expect.any(String),
          });
        }

        expect(
          (await listNetworks()).some(
            (network) =>
              network.id === networkName ||
              network.configuration?.name === networkName,
          ),
        ).toBe(true);
      }),
    180_000,
  );
});
