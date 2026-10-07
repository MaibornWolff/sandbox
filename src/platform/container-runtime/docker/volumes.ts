import { ExecError } from "#platform/process/index.js";
import type { RuntimeExecutor } from "../executor.js";
import type { VolumeOperations } from "../volume-contract.js";

function isMissingVolume(error: unknown): boolean {
  return (
    error instanceof ExecError &&
    /no such volume|volume .* not found/iu.test(
      `${error.stderr}\n${error.stdout}\n${error.message}`,
    )
  );
}

export function createDockerVolumeOperations(
  binaryName: "docker" | "podman",
  exec: RuntimeExecutor,
): VolumeOperations {
  const exists = async (name: string): Promise<boolean> => {
    try {
      await exec(binaryName, ["volume", "inspect", name]);
      return true;
    } catch (error) {
      if (isMissingVolume(error)) return false;
      throw error;
    }
  };
  return {
    exists,
    async create(name) {
      await exec(binaryName, ["volume", "create", name]);
    },
    async remove(request) {
      await exec(binaryName, ["volume", "rm", request.name]);
    },
  };
}
