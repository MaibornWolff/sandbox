import {
  createDependency,
  type DependencyBinding,
} from "#platform/dependency-injection/index.js";
import { readDarwinJobProcesses } from "./darwin.js";
import { createRegistry } from "./registry.js";

export type {
  ForegroundJobPublication,
  ForegroundJobTarget,
  VerifiedForegroundJob,
} from "./registry.js";
export { ForegroundJobMountOverlapError } from "./registry.js";

type ForegroundJobs = ReturnType<typeof createRegistry>;
type ForegroundJobsFactory = () => Promise<ForegroundJobs>;
const foregroundJobs = createDependency<ForegroundJobsFactory>(
  "host foreground jobs",
);

export function provideForegroundJobs(
  open: ForegroundJobsFactory,
): DependencyBinding {
  return foregroundJobs.provide(open);
}

export async function openHostForegroundJobs(): Promise<ForegroundJobs> {
  return createRegistry(await readDarwinJobProcesses());
}

export async function getForegroundJobs(): Promise<ForegroundJobs> {
  return foregroundJobs.get()();
}
