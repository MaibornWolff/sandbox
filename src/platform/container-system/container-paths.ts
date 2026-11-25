/** Marker file the container entrypoint creates once the container is ready for sessions. */
export const CONTAINER_STATE_DIRECTORY = "/run/sandbox";
export const CONTAINER_READY_FILE = `${CONTAINER_STATE_DIRECTORY}/ready`;
export const CONTAINER_START_PHASE_FILE = `${CONTAINER_STATE_DIRECTORY}/start-hooks`;
export const CONTAINER_START_FAILED_FILE = `${CONTAINER_STATE_DIRECTORY}/start-failed`;
/** Directory that holds one marker file per active session, named by its process id. */
export const CONTAINER_SESSIONS_DIRECTORY = "/tmp/sandbox-sessions";
