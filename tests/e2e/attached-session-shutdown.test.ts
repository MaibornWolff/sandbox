import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { generateProjectSlug } from "#shared/text/index.js";
import { verifyAttachedSessions } from "./utils/attached-session.js";
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

test.skipIf(getE2eRuntime() !== "podman")(
  "finalizes only the target Podman session after exit, signals, or PTY close",
  async () => {
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
      await writeProjectFile(
        project,
        ".sandbox/config.toml",
        `clipboard = "disabled"
[[hooks]]
event = "session.end"
command = ["/bin/sh", "./end-hook.sh"]
wait = true
timeout = "20s"
`,
      );
      await writeProjectFile(
        project,
        "guest.sh",
        `set -eu
test -t 0 && test -t 1 && test -t 2 || exit 2
label="$1"
trap 'exit 129' HUP
trap 'exit 143' TERM
printf '%s %s\n' "$$" "$SANDBOX_SESSION_ID" > "$label.pending"
mv "$label.pending" "$label.ready"
while [ ! -e "$label.release" ]; do sleep 0.05; done
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
      sb = createSandbox({
        cwd: project,
        env: { XDG_DATA_HOME: join(project, ".sandbox-test-data") },
      });
      assertSandboxSuccess(await sb.build());
      await verifyAttachedSessions(sb, generateProjectSlug(project));
    } finally {
      await cleanupProject(project, sb);
    }
  },
  720_000,
);
