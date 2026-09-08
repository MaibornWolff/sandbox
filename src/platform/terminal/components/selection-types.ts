export interface SelectionChoice<T> {
  readonly value: T;
  readonly name?: string;
  readonly short?: string;
  readonly description?: string;
  readonly disabled?: boolean | string;
  readonly checked?: boolean;
}

export interface CheckboxConfig<T> {
  readonly message: string;
  readonly choices: readonly SelectionChoice<T>[];
  readonly pageSize?: number;
  readonly loop?: boolean;
  readonly required?: boolean;
  readonly instructions?: string | boolean;
}

export interface SelectConfig<T> {
  readonly message: string;
  readonly choices: readonly SelectionChoice<T>[];
  readonly default?: T;
  readonly pageSize?: number;
  readonly loop?: boolean;
}

export interface NormalizedChoice<T> {
  readonly value: T;
  readonly name: string;
  readonly short: string;
  readonly description?: string;
  readonly disabled: boolean | string;
  checked: boolean;
}

export function normalizeChoices<T>(
  choices: readonly SelectionChoice<T>[],
): NormalizedChoice<T>[] {
  return choices.map((choice) => {
    const name = choice.name ?? String(choice.value);
    return {
      value: choice.value,
      name,
      short: choice.short ?? name,
      description: choice.description,
      disabled: choice.disabled ?? false,
      checked: choice.checked ?? false,
    };
  });
}
