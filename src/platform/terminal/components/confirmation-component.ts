import {
  type Component,
  Key,
  matchesKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import {
  PromptCancellationError,
  type TuiPromptContext,
} from "../tui-prompt.js";

interface ConfirmationOptions {
  readonly message: string;
  readonly default: boolean;
  readonly declineOnCancel: boolean;
}

export class ConfirmationComponent implements Component {
  private answer: boolean;

  constructor(
    private readonly options: ConfirmationOptions,
    private readonly context: TuiPromptContext<boolean>,
  ) {
    this.answer = options.default;
  }

  render(width: number): string[] {
    const lines = this.options.message.trimEnd().split("\n");
    const yes = this.answer ? chalk.cyan.bold("(Y)es") : "(y)es";
    const no = this.answer ? "(n)o" : chalk.cyan.bold("(N)o");
    return lines.flatMap((line, index) => {
      const selection = index === lines.length - 1 ? ` ${yes}/${no}` : "";
      return wrapTextWithAnsi(
        `${index === 0 ? "? " : "  "}${line}${selection}`,
        width,
      );
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape)) {
      if (this.options.declineOnCancel) this.context.done(false);
      else this.context.fail(new PromptCancellationError());
      return;
    }
    if (matchesKey(data, "y") || matchesKey(data, Key.shift("y"))) {
      this.context.done(true);
      return;
    }
    if (matchesKey(data, "n") || matchesKey(data, Key.shift("n"))) {
      this.context.done(false);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.answer = true;
      this.context.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.answer = false;
      this.context.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) this.context.done(this.answer);
  }

  invalidate(): void {}
}
