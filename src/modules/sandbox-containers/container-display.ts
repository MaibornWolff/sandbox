import type { X11Config } from "#platform/environment/index.js";

export function getContainerDisplay(
  hostAccessName: string,
  x11Config: X11Config,
): string | null {
  if (!x11Config.available || !x11Config.display) return null;
  const displayNumber = x11Config.display.match(/:(\d+)/)?.[1] ?? "0";
  return `${hostAccessName}:${displayNumber}`;
}
