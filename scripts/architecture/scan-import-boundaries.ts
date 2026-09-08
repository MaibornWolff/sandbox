import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript-api";

export interface ImportBoundaryViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
      if (entry.isFile() && entry.name.endsWith(".ts")) return [entryPath];
      return [];
    }),
  );
  return files.flat();
}

function getOwner(relativePath: string): string | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  if (/^src\/test(?:\/|$)/u.test(normalized)) return "test";
  const match = normalized.match(
    /^src\/(apps|modules|platform|shared)\/([^/]+)(?:\/|$)/u,
  );
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : undefined;
}

function moduleSpecifier(node: ts.Node): ts.StringLiteral | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const [argument] = node.arguments;
    if (argument && ts.isStringLiteral(argument)) return argument;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    return node.argument.literal;
  }
  return undefined;
}

function aliasFor(relativeTarget: string): string {
  const normalized = relativeTarget.replaceAll("\\", "/");
  if (normalized.startsWith("src/test/")) {
    return `#test/${normalized.slice("src/test/".length)}`;
  }
  return `#${normalized.slice("src/".length)}`;
}

function targetForAlias(specifier: string): string | undefined {
  const match = specifier.match(
    /^#(apps|modules|platform|shared|test)\/(.+)$/u,
  );
  if (!match?.[1] || !match[2]) return undefined;
  return match[1] === "test"
    ? `src/test/${match[2]}`
    : `src/${match[1]}/${match[2]}`;
}

function relativeSpecifier(relativeFile: string, target: string): string {
  const relative = path.posix.relative(
    path.posix.dirname(relativeFile),
    target,
  );
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function importsNamed(node: ts.Node, names: ReadonlySet<string>): boolean {
  return (
    ts.isImportDeclaration(node) &&
    node.importClause?.namedBindings !== undefined &&
    ts.isNamedImports(node.importClause.namedBindings) &&
    node.importClause.namedBindings.elements.some((element) =>
      names.has((element.propertyName ?? element.name).text),
    )
  );
}

function appendScopedOwnershipViolations(options: {
  readonly node: ts.Node;
  readonly sourceFile: ts.SourceFile;
  readonly relativeFile: string;
  readonly sourceOwner: string;
  readonly violations: ImportBoundaryViolation[];
}): void {
  const line =
    options.sourceFile.getLineAndCharacterOfPosition(options.node.getStart())
      .line + 1;
  const normalizedFile = options.relativeFile.replaceAll("\\", "/");
  if (
    normalizedFile !== "src/apps/sandbox/application.ts" &&
    normalizedFile !==
      "src/modules/configuration/configuration-service.test.ts" &&
    importsNamed(options.node, new Set(["provideConfigurationService"]))
  ) {
    options.violations.push({
      file: options.relativeFile,
      line,
      rule: "configuration-provider-composition-only",
      detail:
        "Only host composition and the co-located owner contract test may provide ConfigurationService.",
    });
  }
}

function scanFile(options: {
  readonly sourceFile: ts.SourceFile;
  readonly relativeFile: string;
}): ImportBoundaryViolation[] {
  const violations: ImportBoundaryViolation[] = [];
  const discoveredOwner = getOwner(options.relativeFile);
  if (!discoveredOwner) return violations;
  const sourceOwner: string = discoveredOwner;

  function visit(node: ts.Node): void {
    appendScopedOwnershipViolations({
      node,
      sourceFile: options.sourceFile,
      relativeFile: options.relativeFile,
      sourceOwner,
      violations,
    });
    const specifier = moduleSpecifier(node);
    if (specifier?.text.startsWith(".")) {
      const target = path.posix.normalize(
        path.posix.join(
          path.posix.dirname(options.relativeFile.replaceAll("\\", "/")),
          specifier.text,
        ),
      );
      const targetOwner = getOwner(target);
      if (targetOwner && targetOwner !== sourceOwner) {
        violations.push({
          file: options.relativeFile,
          line:
            options.sourceFile.getLineAndCharacterOfPosition(node.getStart())
              .line + 1,
          rule: "cross-component-import-must-use-alias",
          detail: `Replace ${specifier.text} with ${aliasFor(target)}`,
        });
      }
    } else if (specifier) {
      const target = targetForAlias(specifier.text);
      if (target && getOwner(target) === sourceOwner) {
        violations.push({
          file: options.relativeFile,
          line:
            options.sourceFile.getLineAndCharacterOfPosition(node.getStart())
              .line + 1,
          rule: "same-component-import-must-be-relative",
          detail: `Replace ${specifier.text} with ${relativeSpecifier(options.relativeFile, target)}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(options.sourceFile);
  return violations;
}

export async function scanImportBoundaries(
  rootDirectory: string,
): Promise<ImportBoundaryViolation[]> {
  const violations: ImportBoundaryViolation[] = [];
  const files = await collectTypeScriptFiles(path.join(rootDirectory, "src"));
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    violations.push(
      ...scanFile({
        sourceFile,
        relativeFile: path.relative(rootDirectory, file),
      }),
    );
  }
  return violations;
}
