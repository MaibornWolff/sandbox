/**
 * Global type declarations for the sandbox project
 */

/**
 * Type declarations for files imported with { type: "file" }
 * These are embedded into the compiled binary
 */
declare module "*Dockerfile" {
  const path: string;
  export default path;
}

declare module "*.dockerfile" {
  const path: string;
  export default path;
}

declare module "*.md" {
  const path: string;
  export default path;
}
