import { constants as osConstants } from "node:os";

export function getExitCodeForSignal(signal: NodeJS.Signals): number {
  const signalNumber = osConstants.signals[signal];
  return typeof signalNumber === "number" && signalNumber > 0
    ? 128 + signalNumber
    : 1;
}
