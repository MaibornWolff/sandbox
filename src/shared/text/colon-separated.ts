/**
 * Split a colon-separated value while preserving a Windows drive-letter colon.
 */
export function splitColonString(value: string): string[] {
  if (!/^[A-Za-z]:[/\\]/.test(value)) {
    return value.split(":");
  }

  const afterDrive = value.slice(2);
  const parts = afterDrive.split(":");
  parts[0] = value.slice(0, 2) + parts[0];
  return parts;
}
