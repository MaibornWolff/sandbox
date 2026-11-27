import { expect, test } from "bun:test";
import { copyFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { generateProjectSlug } from "#shared/text/index.js";
import {
  type AttachedSessionScenario,
  verifyAttachedSessions,
} from "./utils/attached-session.js";
import {
  cleanupProject,
  createTempProject,
  writeProjectFile,
} from "./utils/project.js";
import { getE2eRuntime } from "./utils/runtime.js";
import {
  assertSandboxSuccess,
  createSandbox,
  type SandboxInstance,
} from "./utils/sandbox.js";

async function exerciseAttachedSessions(scenario: AttachedSessionScenario) {
  expect(
    Bun.which("podman"),
    "Podman is required for this E2E test",
  ).not.toBeNull();
  expect(
    Bun.which("python3"),
    "Python 3 is required for the PTY fixture",
  ).not.toBeNull();
  const project = await realpath(await createTempProject("attached-session"));
  let sb: SandboxInstance | undefined;
  try {
    const git = Bun.spawnSync(["git", "init", "--quiet"], { cwd: project });
    expect(git.exitCode, git.stderr.toString()).toBe(0);
    const shellRoot =
      scenario === "shell-root" || scenario === "shell-root-no-wrapper";
    await writeProjectFile(
      project,
      ".sandbox/config.toml",
      `clipboard = "disabled"
[[hooks]]
event = "session.end"
command = ["/bin/sh", "./end-hook.sh"]
wait = true
timeout = "20s"
${shellRoot ? '\n[session]\ncommand_wrapper = ["/usr/bin/python3", "./worker-wrapper.py"]\n' : ""}`,
    );
    await writeProjectFile(
      project,
      "guest.sh",
      `set -eu
test -t 0 && test -t 1 && test -t 2 || exit 2
label="$1"
trap 'exit 129' HUP
trap 'exit 143' TERM
printf '%s %s %s\n' "\${E2E_WRAPPER_PID:-$$}" "$SANDBOX_SESSION_ID" "$$" > "$label.pending"
mv "$label.pending" "$label.ready"
while [ ! -e "$label.release" ]; do
  if [ -f "$label.request" ]; then
    read -r request < "$label.request"
    printf '%s %s\\n' "$$" "$request" > "$label.reply.pending"
    mv "$label.reply.pending" "$label.reply"
    rm "$label.request"
  fi
  sleep 0.05
done
exit "$2"
`,
    );
    await writeProjectFile(
      project,
      "end-hook.sh",
      `set -eu
id="$SANDBOX_SESSION_ID"
printf '%s\n' "$id" >> "start-$id"
while [ ! -e "finish-$id" ]; do sleep 0.05; done
printf '%s\n' "$id" >> "end-$id"
`,
    );
    if (shellRoot) {
      await copyFile(
        new URL("./fixtures/session-worker-wrapper.py", import.meta.url),
        join(project, "worker-wrapper.py"),
      );
    }
    sb = createSandbox({
      cwd: project,
      env: { XDG_DATA_HOME: join(project, ".sandbox-test-data") },
    });
    assertSandboxSuccess(await sb.build());
    await verifyAttachedSessions(sb, generateProjectSlug(project), scenario);
  } finally {
    await cleanupProject(project, sb);
  }
}

const skipWithoutPodman = getE2eRuntime() !== "podman";
const skipWithoutMacPodman = skipWithoutPodman || process.platform !== "darwin";

test.skipIf(skipWithoutPodman)(
  "finalizes only the target Podman session after exit, signals, or PTY close",
  () => exerciseAttachedSessions("standard"),
  720_000,
);

test.skipIf(skipWithoutPodman)(
  "finalizes only the target Podman session after two hangups",
  () => exerciseAttachedSessions("repeated-hangup"),
  720_000,
);

test.skipIf(skipWithoutPodman)(
  "retries a timed-out Podman session stop after one hangup",
  () => exerciseAttachedSessions("timed-out-stop"),
  720_000,
);

test.skipIf(skipWithoutMacPodman)(
  "finalizes a wrapped Podman session after closing a shell-root PTY",
  () => exerciseAttachedSessions("shell-root"),
  720_000,
);

test.skipIf(skipWithoutMacPodman)(
  "finalizes an unwrapped Podman session after closing a shell-root PTY",
  () => exerciseAttachedSessions("shell-root-no-wrapper"),
  720_000,
);
