import chalk from "chalk";
import type { RuntimeExecutor } from "../executor.js";
import type { RuntimeHostInfo } from "../types.js";

const INSTALL_HINT =
  "Install Podman: https://podman.io/getting-started/installation";

export function createPodmanHostOperations(exec: RuntimeExecutor): {
  ensureReady(): Promise<RuntimeHostInfo>;
  diskSpaceAdvice(): string;
} {
  let readiness: Promise<RuntimeHostInfo> | undefined;
  return {
    ensureReady() {
      readiness ??= (async () => {
        try {
          const version = (await exec("podman", ["--version"])).trim();
          await exec("podman", ["info"]);
          return {
            version,
            hostAccessName: "host.containers.internal",
            memory: { bytes: null, scope: "unknown" },
          };
        } catch (error) {
          throw new Error(
            `${chalk.red("Podman is not running.")}\n` +
              `First time? Run: ${chalk.cyan("podman machine init")}\n` +
              `Start it with: ${chalk.cyan("podman machine start")}\n` +
              chalk.dim(INSTALL_HINT),
            { cause: error },
          );
        }
      })();
      return readiness;
    },
    diskSpaceAdvice() {
      return [
        chalk.cyan.bold("podman system prune"),
        "  Removes stopped containers, unused networks, dangling images,",
        "  and all build cache. Safe for active images.",
        "",
        chalk.cyan.bold("podman system prune -a"),
        "  Also removes ALL unused images (not just dangling ones).",
        "  Frees more space but the next build will take longer.",
      ].join("\n");
    },
  };
}
