import { reverseDns } from "#platform/container-system/index.js";

/** Pure DNS outcome parsing retained as an owner-local test API. @testonly */
export function buildReverseLookupMap(
  ips: readonly string[],
  outcomes: readonly PromiseSettledResult<readonly string[]>[],
): Map<string, string | null> {
  const uniqueIps = [...new Set(ips)];
  return new Map(
    uniqueIps.map((ip, index) => {
      const outcome = outcomes[index];
      const hostname =
        outcome?.status === "fulfilled" ? (outcome.value[0] ?? null) : null;
      return [ip, hostname];
    }),
  );
}

export async function reverseLookupBatch(
  ips: readonly string[],
): Promise<Map<string, string | null>> {
  const uniqueIps = [...new Set(ips)];
  const outcomes = await Promise.allSettled(uniqueIps.map(reverseDns));
  return buildReverseLookupMap(uniqueIps, outcomes);
}
