interface SettingsManifest {
  readonly mountPaths: readonly string[];
  readonly copyPaths: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = normalized.split("/");
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.includes("\\") &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    )
  );
}

export function createSettingsManifest(options: {
  readonly mountPaths: readonly string[];
  readonly copyPaths: readonly string[];
}): SettingsManifest {
  return {
    mountPaths: [...options.mountPaths],
    copyPaths: [...options.copyPaths],
  };
}

export function serializeSettingsManifest(manifest: SettingsManifest): string {
  return JSON.stringify(manifest);
}

export function parseSettingsManifest(
  serialized: string | undefined,
): SettingsManifest {
  if (!serialized) return { mountPaths: [], copyPaths: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid SANDBOX_SETTINGS: expected valid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).some(
      (key) => key !== "mountPaths" && key !== "copyPaths",
    ) ||
    !("mountPaths" in parsed) ||
    !("copyPaths" in parsed) ||
    !isStringArray(parsed.mountPaths) ||
    !isStringArray(parsed.copyPaths) ||
    [...parsed.mountPaths, ...parsed.copyPaths].some(
      (item) => !isSafeRelativePath(item),
    )
  ) {
    throw new Error(
      "Invalid SANDBOX_SETTINGS: expected mountPaths and copyPaths arrays of safe relative paths",
    );
  }
  return {
    mountPaths: parsed.mountPaths,
    copyPaths: parsed.copyPaths,
  };
}
