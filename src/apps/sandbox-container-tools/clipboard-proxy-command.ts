import { getClipboardProxyRunner } from "#modules/clipboard/index.js";
import { getSandboxEnvironment } from "#platform/environment/index.js";
import { getTerminal } from "#platform/terminal/index.js";

const STOP_EVENTS = ["end", "close", "data"] as const;

export async function runClipboardProxyCommand(): Promise<void> {
  const terminal = getTerminal();
  const control = new AbortController();
  const stop = () => control.abort();
  for (const event of STOP_EVENTS) terminal.input.on(event, stop);
  terminal.input.resume();
  using _control = {
    [Symbol.dispose]() {
      for (const event of STOP_EVENTS) terminal.input.off(event, stop);
      terminal.input.pause();
      control.abort();
    },
  };
  const signal = AbortSignal.any([terminal.signal, control.signal]);
  await getClipboardProxyRunner()
    .run({
      environment: getSandboxEnvironment().variables,
      signal,
      onControl: (line) => terminal.stdout.write(line),
    })
    .catch((error: unknown) => {
      if (!signal.aborted) throw error;
    });
}
