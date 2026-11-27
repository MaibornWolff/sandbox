export interface RuntimeExecOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  /** Stops the command when the signal aborts. */
  readonly signal?: AbortSignal;
}

export type RuntimeExecutor = (
  command: string,
  args?: readonly string[],
  options?: RuntimeExecOptions,
) => Promise<string>;
