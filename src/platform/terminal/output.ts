import { getTerminal } from "./terminal.js";

export function writeStandardOutput(message = ""): void {
  getTerminal().stdout.write(`${message}\n`);
}

export function writeStandardError(message: string): void {
  getTerminal().stderr.write(message);
}
