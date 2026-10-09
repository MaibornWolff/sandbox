import chalk from "chalk";
import { z } from "zod";
import {
  type ReleaseCommand,
  requireCommandSuccess,
} from "./release-command.js";
import type { ReleasePlan } from "./release-plan.js";

const REGISTRY_OPTION = "--registry=https://registry.npmjs.org/";
const npmErrorSchema = z.object({ error: z.object({ code: z.string() }) });

function npmErrorCode(output: string): string | undefined {
  try {
    const result = npmErrorSchema.safeParse(JSON.parse(output || "{}"));
    return result.success ? result.data.error.code : undefined;
  } catch {
    console.error("Warning: npm view returned an invalid JSON error response");
    return undefined;
  }
}

function assertMatchingPublication(
  plan: ReleasePlan,
  integrity: string | null,
): void {
  if (!integrity || integrity !== plan.integrity) {
    throw new Error(
      `npm ${plan.packageName}@${plan.version} does not match the prepared tarball`,
    );
  }
}

export function createReleaseRegistry(options: {
  readonly repoRoot: string;
  readonly execute: ReleaseCommand;
}) {
  function publishedIntegrity(plan: ReleasePlan): string | null {
    const result = options.execute(
      "npm",
      [
        "view",
        `${plan.packageName}@${plan.version}`,
        "dist.integrity",
        "--json",
        REGISTRY_OPTION,
      ],
      options.repoRoot,
    );
    if (result.exitCode === 0)
      return z.string().parse(JSON.parse(result.stdout));
    if (npmErrorCode(result.stdout) === "E404") return null;
    requireCommandSuccess("npm view", result);
    throw new Error("Could not read npm package integrity");
  }

  function assertPublished(plan: ReleasePlan): void {
    assertMatchingPublication(plan, publishedIntegrity(plan));
  }

  function publish(plan: ReleasePlan, tarball: string): void {
    const existingIntegrity = publishedIntegrity(plan);
    if (existingIntegrity) {
      assertMatchingPublication(plan, existingIntegrity);
      console.error(
        chalk.bold(
          "Identical npm version already published. Continuing recovery.",
        ),
      );
      return;
    }

    const result = options.execute(
      "npm",
      ["publish", tarball, "--access=public", "--tag=latest", REGISTRY_OPTION],
      options.repoRoot,
    );
    requireCommandSuccess("npm publish", result);
    assertPublished(plan);
  }

  return { publish, assertPublished };
}
