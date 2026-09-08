import chalk from "chalk";
import { CheckboxComponent } from "./components/checkbox-component.js";
import { SelectComponent } from "./components/select-component.js";
import type {
  CheckboxConfig,
  SelectConfig,
} from "./components/selection-types.js";
import { promptConfirmation } from "./prompt.js";
import { runTuiPrompt } from "./tui-prompt.js";

export function selectCheckbox<T>(config: CheckboxConfig<T>): Promise<T[]> {
  return runTuiPrompt((context) => new CheckboxComponent(config, context));
}

export function selectOne<T>(config: SelectConfig<T>): Promise<T> {
  return runTuiPrompt((context) => new SelectComponent(config, context));
}

export function confirmDestruction(message: string): Promise<boolean> {
  return promptConfirmation(`${chalk.yellow("⚠")} ${message}`);
}
