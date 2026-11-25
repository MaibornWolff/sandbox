/** Marker file the container entrypoint creates once the container is ready for sessions. */
export const CONTAINER_READY_FILE = "/run/sandbox-ready";
export const CONTAINER_START_PHASE_FILE = "/run/sandbox-start-hooks";
export const CONTAINER_START_FAILED_FILE = "/run/sandbox-start-failed";
/** Directory that holds one marker file per active session, named by its process id. */
export const CONTAINER_SESSIONS_DIRECTORY = "/tmp/sandbox-sessions";
