import type {
  SandboxRuntime,
  SandboxStorage,
  SandboxStorageSpec,
} from "#platform/container-runtime/index.js";
import { readState, writeState } from "#platform/state/index.js";

type RuntimeStorageOwner = Pick<SandboxRuntime, "runtime" | "storage">;

function getStorageStateKey(
  runtime: RuntimeStorageOwner,
  spec: SandboxStorageSpec,
): string {
  return `${runtime.runtime}/${spec.scope}/${spec.key}`;
}

export async function ensureRuntimeStorage(
  runtime: RuntimeStorageOwner,
  spec: SandboxStorageSpec,
): Promise<SandboxStorage> {
  const storage = await runtime.storage.ensure(spec);
  const state = readState();
  writeState({
    sandboxStorage: {
      ...state.sandboxStorage,
      [getStorageStateKey(runtime, spec)]: storage,
    },
  });
  return storage;
}

export async function removeRuntimeStorage(
  runtime: RuntimeStorageOwner,
  spec: SandboxStorageSpec,
): Promise<boolean> {
  const state = readState();
  const stateKey = getStorageStateKey(runtime, spec);
  const recorded = state.sandboxStorage?.[stateKey];
  const storage =
    recorded ??
    (spec.scope === "global" ? await runtime.storage.find(spec) : null);
  if (!storage) return false;

  await runtime.storage.remove(storage);
  if (recorded) {
    const remaining = Object.fromEntries(
      Object.entries(state.sandboxStorage ?? {}).filter(
        ([key]) => key !== stateKey,
      ),
    );
    writeState({ sandboxStorage: remaining });
  }
  return true;
}
