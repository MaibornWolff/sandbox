import { expect, test } from "bun:test";
import { createSystemClock } from "#platform/clock/index.js";
import { runWithTestLogger } from "#test/host-test-scope.js";
import { cleanupTestDir, createTestDir } from "#test/utils.js";
import {
  acquireRuntimeCacheLease,
  hasActiveRuntimeCacheLease,
  tryAcquireRuntimeCleanupLock,
} from "./runtime-coordination.js";

const RUNTIME_ID = `1.70.0-${"a".repeat(64)}`;

test("coordinates runtime preparation leases with cleanup locks", async () => {
  const root = createTestDir("runtime-coordination");
  using cleanup = new DisposableStack();
  cleanup.defer(() => cleanupTestDir(root));

  await runWithTestLogger(
    async () => {
      const now = Date.now();
      const cleanupLock = tryAcquireRuntimeCleanupLock(RUNTIME_ID, now);
      expect(cleanupLock).not.toBeNull();
      if (!cleanupLock) throw new Error("Expected cleanup lock");

      const leasePromise = acquireRuntimeCacheLease(RUNTIME_ID);
      cleanupLock[Symbol.dispose]();
      const lease = await leasePromise;
      expect(hasActiveRuntimeCacheLease(RUNTIME_ID, now)).toBe(true);
      await lease[Symbol.asyncDispose]();
      expect(hasActiveRuntimeCacheLease(RUNTIME_ID, now)).toBe(false);
    },
    {
      variables: { XDG_DATA_HOME: root },
      clock: createSystemClock(),
    },
  );
});
