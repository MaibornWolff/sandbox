import type {
  ProcessTestHarness,
  TestProcess,
} from "#platform/process/__test__/index.js";

export function createClipboardSessionFixture(processes: ProcessTestHarness) {
  const sessions: TestProcess[] = [];
  const started = Promise.withResolvers<TestProcess>();
  let startupFailure = false;
  let held = false;
  let nextDisplay = 100;
  const exited = new Set<TestProcess>();
  return {
    sessions,
    waitForStart: () => started.promise,
    exitUnexpectedly() {
      const process = sessions.at(-1);
      if (!process) throw new Error("No clipboard proxy is running.");
      exited.add(process);
      process.exit({ exitCode: 1 });
    },
    failStartup() {
      startupFailure = true;
    },
    holdReadiness() {
      held = true;
    },
    prepare() {
      const process = processes.expectStart({
        match: { name: "container exec stream" },
      });
      void process.waitForStart().then(() => {
        sessions.push(process);
        started.resolve(process);
        if (startupFailure) {
          process.emitStdout(
            `${JSON.stringify({ type: "clipboard-startup-failed", phase: "display", code: "display-executable-unavailable" })}\n`,
          );
          process.exit({ exitCode: 1, stderr: "private raw failure" });
          return;
        }
        if (!held)
          process.emitStdout(
            `${JSON.stringify({ type: "clipboard-ready", display: `:${nextDisplay++}`, authority: `/tmp/private-${nextDisplay}/authority` })}\n`,
          );
        void process.waitForInputEnd().then(() => {
          if (!exited.has(process)) process.exit({ exitCode: 0 });
        });
      });
      return process;
    },
  };
}
