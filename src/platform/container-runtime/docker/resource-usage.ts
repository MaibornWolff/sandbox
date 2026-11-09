import type { ContainerResourceUsage } from "../container-contract.js";

interface StatsRow {
  readonly CPUPerc?: string;
  readonly MemUsage?: string;
  readonly PIDs?: string;
}

const BYTE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1_000,
  kib: 1_024,
  mb: 1_000 ** 2,
  mib: 1_024 ** 2,
  gb: 1_000 ** 3,
  gib: 1_024 ** 3,
  tb: 1_000 ** 4,
  tib: 1_024 ** 4,
};

/** Docker and Podman share the template field names of `stats`. */
export function buildStatsArgs(id: string): string[] {
  return ["stats", "--no-stream", "--format", "{{json .}}", id];
}

function parseBytes(value: string): number | undefined {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/u.exec(value.trim());
  if (!match) return undefined;
  const unit = BYTE_UNITS[(match[2] ?? "").toLowerCase()];
  const amount = Number(match[1]);
  if (unit === undefined || !Number.isFinite(amount)) return undefined;
  return Math.round(amount * unit);
}

function parsePercent(value: string): number | undefined {
  const match = /^([\d.]+)\s*%$/u.exec(value.trim());
  const amount = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(amount) ? amount : undefined;
}

function invalidData(id: string): Error {
  return new Error(`Container statistics for ${id} returned invalid data.`);
}

export function parseResourceUsage(
  output: string,
  id: string,
): ContainerResourceUsage | null {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch (error) {
    throw new Error(`Container statistics for ${id} returned invalid JSON.`, {
      cause: error,
    });
  }
  if (typeof row !== "object" || row === null) throw invalidData(id);
  const { CPUPerc, MemUsage, PIDs } = row as StatsRow;
  if (
    typeof CPUPerc !== "string" ||
    typeof MemUsage !== "string" ||
    typeof PIDs !== "string"
  ) {
    throw invalidData(id);
  }
  const [usage, limit] = MemUsage.split("/");
  const cpuPercent = parsePercent(CPUPerc);
  const memoryUsageBytes = parseBytes(usage ?? "");
  const processCount = Number(PIDs.trim());
  if (
    cpuPercent === undefined ||
    memoryUsageBytes === undefined ||
    !Number.isInteger(processCount)
  ) {
    throw invalidData(id);
  }
  const memoryLimitBytes = limit === undefined ? undefined : parseBytes(limit);
  return {
    cpuPercent,
    memoryUsageBytes,
    memoryLimitBytes: memoryLimitBytes ? memoryLimitBytes : null,
    processCount,
  };
}
