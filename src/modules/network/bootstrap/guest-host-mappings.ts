import { isIpAddress } from "#platform/container-system/index.js";

export interface GuestHostMapping {
  readonly host: string;
  readonly address: string;
}

function invalid(detail: string): never {
  throw new Error(`Invalid guest host mappings: ${detail}`);
}

export function parseGuestHostMappings(
  serialized: string | undefined,
): readonly GuestHostMapping[] {
  if (!serialized) return [];
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    invalid("expected valid JSON");
  }
  if (!Array.isArray(value)) invalid("expected an array");
  const mappings = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid(`entry ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.host !== "string" ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(candidate.host)
    ) {
      invalid(`entry ${index} has an invalid host`);
    }
    if (
      typeof candidate.address !== "string" ||
      !isIpAddress(candidate.address)
    ) {
      invalid(`entry ${index} has an invalid address`);
    }
    return { host: candidate.host, address: candidate.address };
  });
  const byHost = new Map<string, GuestHostMapping>();
  for (const mapping of mappings) {
    const existing = byHost.get(mapping.host);
    if (existing && existing.address !== mapping.address) {
      invalid(`host ${mapping.host} has conflicting addresses`);
    }
    byHost.set(mapping.host, mapping);
  }
  return [...byHost.values()];
}
