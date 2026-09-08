import { describe, expect, test } from "bun:test";
import { getNetworkSessionEnvironment } from "./network-session-environment.js";

const proxyUrl = "http://127.0.0.1:8888";
const noProxy = "localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

describe("getNetworkSessionEnvironment", () => {
  test("provides the complete proxy contract for an attached session", () => {
    expect(getNetworkSessionEnvironment(true)).toEqual({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      GIT_SSH_COMMAND:
        'ssh -o ProxyCommand="socat - PROXY:127.0.0.1:%h:%p,proxyport=8888"',
      JAVA_TOOL_OPTIONS:
        "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=8888 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=8888 -Dhttp.nonProxyHosts=localhost|127.0.0.1|10.*|172.16.*|192.168.*",
      NODE_USE_ENV_PROXY: "1",
    });
  });

  test("does not configure proxy variables when proxy mode is disabled", () => {
    expect(getNetworkSessionEnvironment(false)).toEqual({});
  });
});
