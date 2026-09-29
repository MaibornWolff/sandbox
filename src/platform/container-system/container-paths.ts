/** Marker file the container entrypoint creates once the container is ready for sessions. */
export const CONTAINER_READY_FILE = "/tmp/.sandbox-ready";
/** Directory that holds one marker file per active session, named by its process id. */
export const CONTAINER_SESSIONS_DIRECTORY = "/tmp/sandbox-sessions";
