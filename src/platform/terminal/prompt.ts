import { ConfirmationComponent } from "./components/confirmation-component.js";
import { runTuiPrompt } from "./tui-prompt.js";

export function promptSelectionConfirmation(options: {
  readonly message: string;
  readonly default: boolean;
}): Promise<boolean> {
  return runTuiPrompt(
    (context) =>
      new ConfirmationComponent(
        { ...options, declineOnCancel: false },
        context,
      ),
  );
}

export function promptConfirmation(message: string): Promise<boolean> {
  return runTuiPrompt(
    (context) =>
      new ConfirmationComponent(
        { message, default: false, declineOnCancel: true },
        context,
      ),
  );
}
