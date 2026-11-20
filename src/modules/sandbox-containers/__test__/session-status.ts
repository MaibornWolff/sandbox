import type { ManagedContainer } from "#platform/container-runtime/__test__/index.js";
import {
  formatSessionStatusOutput,
  type SessionStatusOutputSession,
} from "#platform/container-system/__test__/index.js";
import { buildSessionStatusCommand } from "#platform/container-system/index.js";

/** A live session in the session status fixture. */
export interface SessionStatusFixtureSession
  extends Omit<SessionStatusOutputSession, "startedAt"> {
  readonly startedAt?: Date;
}

/** Ready state and sessions that the status probe of one container reports. */
export interface SessionStatusFixture {
  givenReady(ready: boolean): void;
  givenSessions(sessions: readonly SessionStatusFixtureSession[]): void;
  fail(error: Error): void;
}

const DEFAULT_SESSION_START = new Date(Date.UTC(2026, 0, 1));

/**
 * Answer the status probe of `container`. The fake idle check sees the same
 * sessions. By default, the container is ready and has no sessions.
 */
export function createSessionStatusFixture(
  container: ManagedContainer,
): SessionStatusFixture {
  let ready = true;
  let sessions: readonly SessionStatusOutputSession[] = [];

  function update(): void {
    container.givenExecResult(
      buildSessionStatusCommand(),
      formatSessionStatusOutput({ ready, sessions }),
    );
    container.givenSessions(
      sessions.map((session) => ({ pid: String(session.pid) })),
    );
  }
  update();

  return {
    givenReady(nextReady) {
      ready = nextReady;
      update();
    },
    givenSessions(nextSessions) {
      sessions = nextSessions.map((session) => ({
        ...session,
        startedAt: session.startedAt ?? DEFAULT_SESSION_START,
      }));
      update();
    },
    fail(error) {
      container.givenExecResult(buildSessionStatusCommand(), error);
    },
  };
}
