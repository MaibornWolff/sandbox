export function parseSizeToBytes(sizeStr: string): number {
  const match = sizeStr.match(/^([\d.]+)\s*([A-Z]+)$/i);
  if (!match || match.length < 3) return 0;
  const [, valueStr = "", unit = ""] = match;
  if (!valueStr || !unit) return 0;
  const value = Number.parseFloat(valueStr);
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000,
    MB: 1000 * 1000,
    GB: 1000 * 1000 * 1000,
    TB: 1000 * 1000 * 1000 * 1000,
  };
  return value * (multipliers[unit.toUpperCase()] || 0);
}
