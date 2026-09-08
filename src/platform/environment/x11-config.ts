export interface X11Config {
  readonly available: boolean;
  readonly display: string | null;
  readonly socketPath: string | null;
  readonly platform: "darwin" | "linux" | "win32";
}
