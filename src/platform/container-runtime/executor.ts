export interface RuntimeExecOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
}

export type RuntimeExecutor = (
  command: string,
  args?: readonly string[],
  options?: RuntimeExecOptions,
) => Promise<string>;
