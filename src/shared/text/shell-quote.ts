/** Shell-quote an argument for safe copyable display. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[a-zA-Z0-9._\-/:=@]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
