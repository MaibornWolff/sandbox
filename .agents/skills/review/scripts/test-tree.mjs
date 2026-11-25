import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";

const names = new Set(["describe", "it", "test"]);
const modifiers = new Set([
  "concurrent",
  "failing",
  "only",
  "serial",
  "skip",
  "todo",
]);
const factories = new Set(["each", "if", "skipIf", "todoIf"]);

function declaration(expression) {
  if (ts.isIdentifier(expression) && names.has(expression.text)) {
    return { name: expression.text, label: expression.text };
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    modifiers.has(expression.name.text)
  ) {
    const base = declaration(expression.expression);
    if (base)
      return { ...base, label: `${base.label}.${expression.name.text}` };
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression)
  ) {
    const { name, expression: receiver } = expression.expression;
    if (!factories.has(name.text)) return;
    const base = declaration(receiver);
    if (base) return { ...base, label: `${base.label}.${name.text}` };
  }
}

function testEntry(node, source) {
  if (!ts.isCallExpression(node)) return;
  const kind = declaration(node.expression);
  const [title, body] = node.arguments;
  if (!kind || !title) return;
  const suite = kind.name === "describe";
  if (suite && !body) return;
  const line =
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const name = ts.isStringLiteralLike(title)
    ? JSON.stringify(title.text)
    : `[expression: ${JSON.stringify(title.getText(source))}]`;
  const children = [];
  if (suite) collect(body, source, children);
  return {
    key: `${suite ? "suite" : "test"} ${name}`,
    code: suite ? node.expression.getText(source) : node.getText(source),
    text: `${kind.label} ${name} (line ${line})`,
    suite,
    children,
  };
}

function collect(node, source, entries) {
  const entry = testEntry(node, source);
  if (entry) entries.push(entry);
  else ts.forEachChild(node, (child) => collect(child, source, entries));
}

function parse(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const entries = [];
  collect(source, source, entries);
  return entries;
}

function pairEntries(before, after) {
  const byKey = new Map();
  for (const entry of before) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, []);
    byKey.get(entry.key).push(entry);
  }
  const pairs = after.map((entry) => [byKey.get(entry.key)?.shift(), entry]);
  for (const remaining of byKey.values()) {
    for (const entry of remaining) pairs.push([entry, undefined]);
  }

  return pairs;
}

function markEntry(before, after, changed) {
  if (!before) return "+";
  if (!after) return "-";
  return changed ? "~" : "";
}

function compare(before, after, changesOnly, suiteChanged = false) {
  return pairEntries(before, after).flatMap(([oldEntry, newEntry]) => {
    const entry = newEntry ?? oldEntry;
    const changed = suiteChanged || oldEntry?.code !== newEntry?.code;
    const children = compare(
      oldEntry?.children ?? [],
      newEntry?.children ?? [],
      changesOnly,
      changed,
    );
    const mark = markEntry(oldEntry, newEntry, changed);
    if (changesOnly && (entry.suite ? children.length === 0 : !mark)) return [];
    return [{ text: mark ? `${mark} ${entry.text}` : entry.text, children }];
  });
}

function print(entries, indent = "") {
  entries.forEach(({ text, children }, index) => {
    const last = index === entries.length - 1;
    console.log(`${indent}${last ? "└──" : "├──"} ${text}`);
    print(children, `${indent}${last ? "    " : "│   "}`);
  });
}

function git(args, cwd = process.cwd()) {
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "HEAD" },
      head: { type: "string" },
      folder: { type: "string" },
      "changes-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: bun .agents/skills/review/scripts/test-tree.mjs [--base <ref>] [--head <ref>] [--folder <repo-relative-dir>] [--changes-only]",
    );
    console.log(
      "Default: compare HEAD to the working tree, including untracked test files.",
    );
    return;
  }

  const root = git(["rev-parse", "--show-toplevel"]).trimEnd();
  const resolveRef = (ref) =>
    git(
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      root,
    ).trim();
  const base = resolveRef(values.base);
  const head = values.head === undefined ? undefined : resolveRef(values.head);
  const scope = folderScope(values.folder);
  printDiff(root, base, head, scope, values["changes-only"] ?? false);
}

function folderScope(value) {
  const scope = ["--"];
  if (value !== undefined) {
    const folder = path.normalize(value);
    if (
      path.isAbsolute(folder) ||
      folder === ".." ||
      folder.startsWith(`..${path.sep}`)
    ) {
      throw new Error("--folder must be a path inside the repository.");
    }
    scope.push(folder);
  }
  return scope;
}

function fileStatuses(root, base, head, scope) {
  const changed = git(
    [
      "diff",
      "--name-status",
      "--no-renames",
      "--diff-filter=ADMT",
      "-z",
      base,
      ...(head ? [head] : []),
      ...scope,
    ],
    root,
  ).split("\0");
  const untracked = head
    ? []
    : git(
        ["ls-files", "--others", "--exclude-standard", "-z", ...scope],
        root,
      ).split("\0");
  const statuses = new Map();
  for (let i = 0; i + 1 < changed.length; i += 2) {
    statuses.set(changed[i + 1], changed[i]);
  }
  for (const file of untracked.filter(Boolean)) {
    statuses.set(
      file,
      statuses.get(file) === "D" ? "M" : (statuses.get(file) ?? "A"),
    );
  }
  return statuses;
}

function readEntries(root, file, ref) {
  return parse(
    file,
    ref
      ? git(["show", `${ref}:${file}`], root)
      : readFileSync(path.join(root, file), "utf8"),
  );
}

function printDiff(root, base, head, scope, changesOnly) {
  const statuses = fileStatuses(root, base, head, scope);
  const files = [...statuses.keys()]
    .filter((file) => /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(file))
    .sort();

  let printed = false;
  for (const file of files) {
    const status = statuses.get(file);
    const before = status === "A" ? [] : readEntries(root, file, base);
    const after = status === "D" ? [] : readEntries(root, file, head);
    const entries = compare(before, after, changesOnly);
    if (changesOnly && entries.length === 0) continue;
    if (!printed) console.log("+ added   ~ changed   - removed");
    printed = true;
    console.log(file);
    if (entries.length === 0)
      console.log("└── (no recognized test declarations)");
    print(entries);
  }
  if (!printed)
    console.log(
      changesOnly
        ? "No changed test declarations in scope."
        : "No changed test files in scope.",
    );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
