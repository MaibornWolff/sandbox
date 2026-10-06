import * as path from "node:path";
import { getHostEnvironment } from "#platform/environment/index.js";

export function getStatePath(): string {
  return path.join(
    getHostEnvironment().dataHomeDirectory,
    "sandbox",
    "state.json",
  );
}
