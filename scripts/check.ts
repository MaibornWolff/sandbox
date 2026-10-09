interface CheckResult {
  readonly step: CheckStep;
  readonly passed: boolean;
  readonly output: string;
}

export interface CheckCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const mutatingSteps = ["lint", "build"] as const;
const readOnlySteps = [
  "typecheck",
  "deprecations",
  "architecture",
  "cpd",
  "knip",
  "test:scripts",
] as const;
const finalSteps = ["coverage:check"] as const;

type CheckStep =
  | (typeof mutatingSteps)[number]
  | (typeof readOnlySteps)[number]
  | (typeof finalSteps)[number];

interface RunChecksOptions {
  readonly verbose: boolean;
  readonly runStep: (step: CheckStep) => Promise<CheckCommandResult>;
  readonly log: (message: string) => void;
}

export interface RunChecksResult {
  readonly exitCode: number;
  readonly failures: readonly CheckResult[];
}

async function runCommand(step: CheckStep): Promise<CheckCommandResult> {
  const child = Bun.spawn([process.execPath, "run", step], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function describeThrownValue(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  return String(value);
}

async function executeStep(
  step: CheckStep,
  options: RunChecksOptions,
): Promise<CheckResult> {
  try {
    const result = await options.runStep(step);
    const passed = result.exitCode === 0;
    options.log(`▶ ${step}... ${passed ? "✅" : "❌"}`);
    return {
      step,
      passed,
      output: [result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    };
  } catch (error: unknown) {
    options.log(`▶ ${step}... ❌`);
    return {
      step,
      passed: false,
      output: `Step runner failed: ${describeThrownValue(error)}`,
    };
  }
}

async function runSequentialPhase(
  steps: readonly CheckStep[],
  options: RunChecksOptions,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const step of steps) {
    results.push(await executeStep(step, options));
  }
  return results;
}

async function runParallelPhase(
  steps: readonly CheckStep[],
  options: RunChecksOptions,
): Promise<CheckResult[]> {
  return Promise.all(steps.map((step) => executeStep(step, options)));
}

export async function runChecks(
  options: RunChecksOptions,
): Promise<RunChecksResult> {
  const mutatingResults = await runSequentialPhase(mutatingSteps, options);
  const readOnlyResults = await runParallelPhase(readOnlySteps, options);
  const finalResults = await runSequentialPhase(finalSteps, options);
  const results = [...mutatingResults, ...readOnlyResults, ...finalResults];
  const failures = results.filter((result) => !result.passed);
  const stepsToLog = options.verbose ? results : failures;
  for (const { step, output } of stepsToLog) {
    if (!output) continue;
    options.log(`--- ${step} output ---`);
    options.log(output);
    options.log("--------------------");
  }

  if (failures.length === 0) options.log("All checks passed ✅");
  return { exitCode: failures.length === 0 ? 0 : 1, failures };
}

if (import.meta.main) {
  const result = await runChecks({
    verbose: process.argv.includes("--verbose"),
    runStep: runCommand,
    log: console.log,
  });
  process.exitCode = result.exitCode;
}
