export function assertMergeGate({ check, security, e2e, renovate }) {
  if (check !== "success" || security !== "success") {
    throw new Error("Checks and dependency security must succeed");
  }
  if (renovate && e2e !== "success") {
    throw new Error("Renovate requires successful container E2E tests");
  }
  if (!renovate && !["success", "skipped"].includes(e2e)) {
    throw new Error("Requested container E2E tests must succeed");
  }
}

export function evaluateWorkflowRuns(runs, requirements, sourceCommit) {
  return requirements.map(({ path, jobs }) => {
    const run = runs
      .filter(
        (entry) =>
          entry.path === path &&
          entry.head_sha === sourceCommit &&
          entry.event === "push" &&
          entry.head_branch === "main",
      )
      .sort((left, right) => right.id - left.id)[0];
    if (!run || run.status !== "completed")
      return { path, state: "pending", jobs };
    if (run.conclusion !== "success")
      throw new Error(`${path} did not succeed for ${sourceCommit}`);
    return { path, state: "success", jobs, run };
  });
}

export function assertRequiredJobs(jobs, requiredNames) {
  for (const name of requiredNames) {
    if (
      !jobs.some((job) => job.name === name && job.conclusion === "success")
    ) {
      throw new Error(`Required CI job did not succeed: ${name}`);
    }
  }
}

export function assertApprovalEnvironment(environment) {
  const reviewersRequired = environment.protection_rules?.some(
    (rule) => rule.type === "required_reviewers" && rule.reviewers?.length > 0,
  );
  if (!reviewersRequired) {
    throw new Error(
      "Configure required reviewers on npm-release-approval before publishing",
    );
  }
}

export function assertReusableCandidate(run, sourceCommit, workflowId) {
  if (
    run.workflow_id !== workflowId ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.head_sha !== sourceCommit ||
    run.conclusion !== "success"
  ) {
    throw new Error(
      "Candidate must come from a successful Release run on the current main commit",
    );
  }
}

export async function waitForSourceCI({
  github,
  context,
  core,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 120,
}) {
  const requirements = [
    {
      path: ".github/workflows/ci.yml",
      jobs: [
        "Check",
        "Dependency security",
        "End-to-end tests (docker)",
        "End-to-end tests (podman)",
        "Merge gate",
      ],
    },
    { path: ".github/workflows/compliance.yml", jobs: ["License and SBOM"] },
    {
      path: ".github/workflows/codeql.yml",
      jobs: ["Analyze JavaScript and TypeScript"],
    },
  ];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const runs = await github.paginate(
      github.rest.actions.listWorkflowRunsForRepo,
      { ...context.repo, head_sha: context.sha, event: "push", per_page: 100 },
    );
    const states = evaluateWorkflowRuns(runs, requirements, context.sha);
    if (states.every((entry) => entry.state === "success")) {
      for (const entry of states) {
        const jobs = await github.paginate(
          github.rest.actions.listJobsForWorkflowRun,
          {
            ...context.repo,
            run_id: entry.run.id,
            filter: "latest",
            per_page: 100,
          },
        );
        assertRequiredJobs(jobs, entry.jobs);
      }
      core.info(`All source CI gates passed for ${context.sha}`);
      return;
    }
    core.info(
      `Waiting for source CI: ${states
        .filter((entry) => entry.state === "pending")
        .map((entry) => entry.path)
        .join(", ")}`,
    );
    if (attempt + 1 < attempts) await sleep(30000);
  }
  throw new Error(`Timed out waiting for source CI on ${context.sha}`);
}
