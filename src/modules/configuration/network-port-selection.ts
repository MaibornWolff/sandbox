export const ALL_NETWORK_PORTS = "*" as const;
const MIN_NETWORK_PORT = 1;
const MAX_NETWORK_PORT = 65_535;

export type NetworkPortSelection = number[] | typeof ALL_NETWORK_PORTS;

export function isNetworkPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_NETWORK_PORT &&
    value <= MAX_NETWORK_PORT
  );
}

export function isNetworkPortSelection(
  value: unknown,
): value is NetworkPortSelection {
  return (
    value === ALL_NETWORK_PORTS ||
    (Array.isArray(value) && value.every(isNetworkPort))
  );
}

export function allowsAllNetworkPorts(
  selection: unknown,
): selection is typeof ALL_NETWORK_PORTS {
  return selection === ALL_NETWORK_PORTS;
}

export function getExplicitNetworkPorts(
  selection: NetworkPortSelection,
): readonly number[] {
  return allowsAllNetworkPorts(selection) ? [] : selection;
}

export function networkPortSelectionIncludes(
  selection: NetworkPortSelection,
  port: number,
): boolean {
  return allowsAllNetworkPorts(selection) || selection.includes(port);
}

export function mergeNetworkPortSelections(
  ...selections: readonly (NetworkPortSelection | undefined)[]
): NetworkPortSelection {
  const ports = new Set<number>();
  for (const selection of selections) {
    if (selection === undefined) continue;
    if (allowsAllNetworkPorts(selection)) return ALL_NETWORK_PORTS;
    for (const port of selection) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

export function formatNetworkPortSelection(
  selection: NetworkPortSelection,
  options: { readonly allPorts: string; readonly separator: string },
): string {
  if (allowsAllNetworkPorts(selection)) return options.allPorts;
  return [...new Set(selection)]
    .sort((left, right) => left - right)
    .join(options.separator);
}
