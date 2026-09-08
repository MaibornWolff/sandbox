const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export function log(message: string): void {
  console.log(`  ${DIM}[${timestamp()}] ${message}${RESET}`);
}

export function logError(message: string): void {
  console.log(`  ${RED}[${timestamp()}] ${message}${RESET}`);
}

export function logLines(prefix: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const fn = prefix === "stderr" ? logError : log;
  for (const line of trimmed.split("\n")) {
    fn(`  ${prefix}: ${line}`);
  }
}
