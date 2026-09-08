import {
  type Component,
  type TUI,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { getTerminal } from "./terminal.js";

export class PromptCancellationError extends Error {
  constructor() {
    super("The interactive prompt was cancelled.");
    this.name = "PromptCancellationError";
  }
}

export interface TuiPromptContext<T> {
  readonly tui: TUI;
  done(value: T): void;
  fail(error: Error): void;
}

export function runTuiPrompt<T>(
  createComponent: (context: TuiPromptContext<T>) => Component,
): Promise<T> {
  const terminal = getTerminal();
  if (terminal.signal.aborted) {
    return Promise.reject(
      terminal.signal.reason ?? new Error("Terminal input was cancelled."),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const tui = new TuiMainScreen(terminal);
    let settled = false;

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      terminal.signal.removeEventListener("abort", onAbort);
      tui.stop();
      complete();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          terminal.signal.reason ?? new Error("Terminal input was cancelled."),
        ),
      );
    const component = createComponent({
      tui,
      done: (value) => finish(() => resolve(value)),
      fail: (error) => finish(() => reject(error)),
    });

    terminal.signal.addEventListener("abort", onAbort, { once: true });
    tui.addChild(component);
    tui.setFocus(component);
    tui.start();
  });
}
