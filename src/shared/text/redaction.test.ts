import { describe, expect, test } from "bun:test";
import {
  createRedactionContext,
  isSecretKey,
  redactCommandArgs,
  redactCommandForDisplay,
  redactDockerCommand,
  redactEnvValue,
} from "./redaction.js";

describe("isSecretKey", () => {
  test("detects uppercase secret patterns", () => {
    expect(isSecretKey("API_KEY")).toBe(true);
    expect(isSecretKey("AUTH_TOKEN")).toBe(true);
    expect(isSecretKey("DATABASE_PASSWORD")).toBe(true);
    expect(isSecretKey("JWT_SECRET")).toBe(true);
    expect(isSecretKey("SESSION_COOKIE")).toBe(true);
    expect(isSecretKey("OAUTH_CREDENTIAL")).toBe(true);
  });

  test("detects lowercase secret patterns", () => {
    expect(isSecretKey("api_key")).toBe(true);
    expect(isSecretKey("auth_token")).toBe(true);
    expect(isSecretKey("password")).toBe(true);
    expect(isSecretKey("secret")).toBe(true);
    expect(isSecretKey("session_id")).toBe(true);
  });

  test("detects mixed case secret patterns", () => {
    expect(isSecretKey("ApiKey")).toBe(true);
    expect(isSecretKey("authToken")).toBe(true);
    expect(isSecretKey("myPassword")).toBe(true);
    expect(isSecretKey("github_token")).toBe(true);
  });

  test("does not flag non-secret keys", () => {
    expect(isSecretKey("DEBUG")).toBe(false);
    expect(isSecretKey("NODE_ENV")).toBe(false);
    expect(isSecretKey("PORT")).toBe(false);
    expect(isSecretKey("DATABASE_URL")).toBe(false);
    expect(isSecretKey("LOG_LEVEL")).toBe(false);
  });
});

describe("redactCommandForDisplay", () => {
  test("redacts before shell quoting", () => {
    const result = redactCommandForDisplay("docker", [
      "run",
      "-e",
      "API_KEY=secret value with spaces",
      "image name",
    ]);

    expect(result).toBe("docker run -e 'API_KEY=<redacted>' 'image name'");
    expect(result).not.toContain("secret value");
  });

  test("quotes shell-sensitive redacted args", () => {
    expect(
      redactCommandForDisplay("docker", [
        "run",
        "--env",
        "DEBUG=value with spaces",
        "weird'image",
      ]),
    ).toBe("docker run --env 'DEBUG=value with spaces' 'weird'\\''image'");
  });

  test("returns only command when there are no args", () => {
    expect(redactCommandForDisplay("docker")).toBe("docker");
  });
});

describe("redactDockerCommand", () => {
  test("keeps legacy string redaction delegated to command display", () => {
    expect(redactDockerCommand("docker run -e API_KEY=secret image")).toBe(
      "docker run -e 'API_KEY=<redacted>' image",
    );
  });
});

describe("redactCommandArgs", () => {
  test("redacts secret values in -e KEY=VALUE pairs", () => {
    expect(
      redactCommandArgs([
        "run",
        "-e",
        "EXAMPLE_API_KEY=secret",
        "-e",
        "DEBUG=true",
        "image",
      ]),
    ).toEqual([
      "run",
      "-e",
      "EXAMPLE_API_KEY=<redacted>",
      "-e",
      "DEBUG=true",
      "image",
    ]);
  });

  test("redacts secret values in --env KEY=VALUE pairs", () => {
    expect(
      redactCommandArgs(["run", "--env", "GITHUB_TOKEN=secret", "image"]),
    ).toEqual(["run", "--env", "GITHUB_TOKEN=<redacted>", "image"]);
  });

  test("redacts secret values in --env=KEY=VALUE form", () => {
    expect(
      redactCommandArgs([
        "run",
        "--env=AUTH_TOKEN=secret",
        "--env=DEBUG=true",
        "image",
      ]),
    ).toEqual([
      "run",
      "--env=AUTH_TOKEN=<redacted>",
      "--env=DEBUG=true",
      "image",
    ]);
  });

  test("redacts secret values in --build-arg KEY=VALUE pairs", () => {
    expect(
      redactCommandArgs([
        "build",
        "--build-arg",
        "GITHUB_TOKEN=ghp_secret",
        "--build-arg",
        "HOST_UID=1000",
      ]),
    ).toEqual([
      "build",
      "--build-arg",
      "GITHUB_TOKEN=<redacted>",
      "--build-arg",
      "HOST_UID=1000",
    ]);
  });

  test("redacts secret values in --build-arg=KEY=VALUE form", () => {
    expect(
      redactCommandArgs([
        "build",
        "--build-arg=AUTH_TOKEN=secret=with=equals",
        "--build-arg=HOST_UID=1000",
      ]),
    ).toEqual([
      "build",
      "--build-arg=AUTH_TOKEN=<redacted>",
      "--build-arg=HOST_UID=1000",
    ]);
  });

  test("handles assignment values with spaces, quotes, and shell-sensitive characters", () => {
    expect(
      redactCommandArgs([
        "run",
        "-e",
        "API_KEY=value with spaces 'and quotes' $HOME",
      ]),
    ).toEqual(["run", "-e", "API_KEY=<redacted>"]);
  });

  test("masks URL credentials for non-secret assignment keys", () => {
    expect(
      redactCommandArgs([
        "run",
        "-e",
        "DATABASE_URL=postgres://user:password@host/db",
      ]),
    ).toEqual(["run", "-e", "DATABASE_URL=postgres://user:<redacted>@host/db"]);
  });

  test("keeps non-secret values visible when they have no embedded credentials", () => {
    expect(redactCommandArgs(["run", "-e", "DEBUG=true", "image"])).toEqual([
      "run",
      "-e",
      "DEBUG=true",
      "image",
    ]);
  });

  test("preserves passthrough env args without values", () => {
    expect(redactCommandArgs(["run", "-e", "PATH", "image"])).toEqual([
      "run",
      "-e",
      "PATH",
      "image",
    ]);
  });
});

describe("redactEnvValue", () => {
  test("fully masks secret values", () => {
    expect(redactEnvValue("API_KEY", "sk-verylongsecret123456")).toBe(
      "<redacted>",
    );
    expect(redactEnvValue("PASSWORD", "ab")).toBe("<redacted>");
    expect(redactEnvValue("api_key", "secretvalue123")).toBe("<redacted>");
  });

  test("does not redact non-secret values without embedded credentials", () => {
    expect(redactEnvValue("DEBUG", "true")).toBe("true");
  });

  test("masks username-password, username-only, and empty URL credentials", () => {
    expect([
      redactEnvValue("DATABASE_URL", "postgresql://user:pass@localhost/db"),
      redactEnvValue("DATABASE_URL", "postgresql://user@localhost/db"),
      redactEnvValue("DATABASE_URL", "postgresql://:@localhost/db"),
    ]).toEqual([
      "postgresql://user:<redacted>@localhost/db",
      "postgresql://<redacted>@localhost/db",
      "postgresql://:<redacted>@localhost/db",
    ]);
  });

  test("handles empty values", () => {
    expect(redactEnvValue("PASSWORD", "")).toBe("<redacted>");
    expect(redactEnvValue("DEBUG", "")).toBe("");
  });
});

describe("createRedactionContext", () => {
  test("redacts known secret values from args", () => {
    const context = createRedactionContext({
      args: ["build", "--build-arg", "GITHUB_TOKEN=ghp_secret"],
    });

    expect(context.redactText("authentication failed for ghp_secret")).toBe(
      "authentication failed for <redacted>",
    );
  });

  test("redacts known secret values from env", () => {
    const context = createRedactionContext({
      env: { API_KEY: "sk-secret", DEBUG: "true" },
    });

    expect(context.redactText("token sk-secret debug true")).toBe(
      "token <redacted> debug true",
    );
  });

  test("redacts inline secrets and URL credentials from argument and environment values", () => {
    const context = createRedactionContext({
      args: [
        "run",
        "--env=API_TOKEN=https://argument-user:argument-password@host/token",
      ],
      env: { REMOTE_URL: "https://environment-user@host/repository" },
    });

    expect(
      context.redactText(
        "https://argument-user:argument-password@host/token argument-password argument-user:argument-password environment-user",
      ),
    ).toBe("<redacted> <redacted> <redacted> <redacted>");
  });

  test("does not use very short known values as broad replacement targets", () => {
    const context = createRedactionContext({
      args: ["run", "-e", "API_KEY=ab"],
      env: { AUTH_TOKEN: "xy" },
    });

    expect(context.redactText("ab xy abc xyz stays visible")).toBe(
      "ab xy abc xyz stays visible",
    );
  });
});
