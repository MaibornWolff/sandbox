import chalk from "chalk";
import type { RuntimeExecutor } from "../executor.js";
import type { RuntimeHostInfo } from "../types.js";

const INSTALL_HINT = "Install Docker: https://docs.docker.com/get-docker/";

export function createDockerHostOperations(exec: RuntimeExecutor): {
  ensureReady(): Promise<RuntimeHostInfo>;
  diskSpaceAdvice(): string;
} {
  let readiness: Promise<RuntimeHostInfo> | undefined;
  return {
    ensureReady() {
      readiness ??= (async () => {
        let version: string;
        let output: string;
        try {
          version = (await exec("docker", ["--version"])).trim();
          output = await exec("docker", ["info", "--format", "{{.MemTotal}}"]);
        } catch (error) {
          throw new Error(
            `${chalk.red("Docker daemon is not running.")}\n` +
              `Start it with ${chalk.cyan("Rancher Desktop")}, ${chalk.cyan("Colima")}, or your preferred method.\n` +
              chalk.dim(INSTALL_HINT),
            { cause: error },
          );
        }
        const memoryBytes = Number.parseInt(output.trim(), 10);
        if (Number.isNaN(memoryBytes)) {
          throw new Error("Docker returned invalid runtime memory data.");
        }
        return {
          version,
          hostAccessName: "host.docker.internal",
          memory: { bytes: memoryBytes, scope: "shared-runtime-vm" },
        };
      })();
      return readiness;
    },
    diskSpaceAdvice() {
      return [
        chalk.cyan.bold("docker system prune"),
        "  Removes stopped containers, unused networks, dangling images,",
        "  and all build cache. Safe for active images.",
        "",
        chalk.cyan.bold("docker system prune -a"),
        "  Also removes ALL unused images (not just dangling ones).",
        "  Frees more space but the next build will take longer.",
      ].join("\n");
    },
  };
}
