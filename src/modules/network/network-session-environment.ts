const PROXY_URL = "http://127.0.0.1:8888";
const NO_PROXY = "localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

export function getNetworkSessionEnvironment(
  proxyEnabled: boolean,
): Readonly<Record<string, string>> {
  if (!proxyEnabled) return {};

  return {
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    NO_PROXY,
    no_proxy: NO_PROXY,
    GIT_SSH_COMMAND:
      'ssh -o ProxyCommand="socat - PROXY:127.0.0.1:%h:%p,proxyport=8888"',
    JAVA_TOOL_OPTIONS:
      "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=8888 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=8888 -Dhttp.nonProxyHosts=localhost|127.0.0.1|10.*|172.16.*|192.168.*",
    NODE_USE_ENV_PROXY: "1",
  };
}
