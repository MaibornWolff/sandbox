function normalizeReference(reference: string): string {
  const parts = reference.split("/");
  const first = parts[0] ?? "";
  const hasRegistry =
    parts.length > 1 &&
    (first.includes(".") || first.includes(":") || first === "localhost");
  let normalized = hasRegistry ? reference : `docker.io/${reference}`;
  normalized = normalized.replace(/^index\.docker\.io\//u, "docker.io/");
  if (
    normalized.startsWith("docker.io/") &&
    normalized.split("/").length === 2
  ) {
    normalized = normalized.replace("docker.io/", "docker.io/library/");
  }
  if (
    !normalized.includes("@") &&
    !normalized.split("/").at(-1)?.includes(":")
  ) {
    normalized += ":latest";
  }
  return normalized;
}

export function matchesImageReference(
  reference: string,
  image: { readonly id: string; readonly references: readonly string[] },
): boolean {
  const identity = reference.replace(/^sha256:/u, "");
  if (
    /^[a-f0-9]{4,64}$/u.test(identity) &&
    image.id.replace(/^sha256:/u, "").startsWith(identity)
  ) {
    return true;
  }
  return image.references.some(
    (candidate) =>
      normalizeReference(candidate) === normalizeReference(reference),
  );
}
