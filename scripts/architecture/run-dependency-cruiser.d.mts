import type { ICruiseResult } from "dependency-cruiser";

export function validateCruiseResult(output: unknown): ICruiseResult;
export function runDependencyCruiser(options: {
  readonly configPath: string;
  readonly input: string;
  readonly tsconfig: string;
}): Promise<ICruiseResult>;
