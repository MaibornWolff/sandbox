import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import {
  PromptCancellationError,
  type TuiPromptContext,
} from "#platform/terminal/index.js";

export interface CapabilityEditorController {
  render(width: number): string[];
  handleInput(data: string): readonly string[] | undefined;
}

export class CapabilityEditorComponent implements Component {
  constructor(
    private readonly controller: CapabilityEditorController,
    private readonly context: TuiPromptContext<string[]>,
  ) {}

  render(width: number): string[] {
    return this.controller.render(width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.context.fail(new PromptCancellationError());
      return;
    }
    const result = this.controller.handleInput(data);
    if (result) {
      this.context.done([...result]);
      return;
    }
    this.context.tui.requestRender();
  }

  invalidate(): void {}
}
