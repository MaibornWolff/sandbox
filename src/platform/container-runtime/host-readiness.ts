/** A runtime host check failure that carries a plain-text start hint. */
export class RuntimeHostNotReadyError extends Error {
  constructor(
    message: string,
    readonly hint: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeHostNotReadyError";
  }
}
