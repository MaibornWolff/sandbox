import {
  ALL_NETWORK_PORTS,
  formatNetworkPortSelection,
  type NetworkPortSelection,
} from "#modules/configuration/index.js";
import {
  getSquidDomainAclPath,
  type SquidDomainAclGroup,
} from "#platform/container-system/index.js";
import type { NetworkBootstrapRequest } from "./bootstrap-request-parsing.js";

const SQUID_COMMON = `http_port 127.0.0.1:8888 tcpkeepalive=60,10,6
cache deny all
access_log stdio:/var/log/proxy-access.log squid
cache_log /var/log/squid-cache.log
cache_store_log none
via off
forwarded_for delete
visible_hostname sandbox-proxy
httpd_suppress_version_string on
shutdown_lifetime 1 seconds
dns_nameservers 127.0.0.1
pid_filename /run/squid.pid

maximum_object_size 0 KB
client_db off
max_filedescriptors 65536
client_ip_max_connections 0
fqdncache_size 4096
ipcache_size 4096
negative_dns_ttl 0 seconds
pinger_enable off
connect_retries 5
forward_max_tries 25
retry_on_error on

connect_timeout 120 seconds
read_timeout 10 minutes
write_timeout 10 minutes
request_timeout 120 seconds
persistent_request_timeout 120 seconds
forward_timeout 120 seconds

half_closed_clients on
server_persistent_connections on
client_persistent_connections on
`;

const BLOCKED_ERROR_PAGE =
  "HTTP 403 Blocked: %H is not in the domain allowlist. Use 'sandbox network allow' to allow, or 'sandbox network logs' to inspect.\n";

function removeDomainsCoveredByWildcard(
  domains: ReadonlySet<string>,
): string[] {
  const wildcardDomains = [...domains]
    .filter((domain) => domain.startsWith("."))
    .map((domain) => domain.slice(1));
  return [...domains].filter((domain) => {
    if (domain.startsWith(".")) return true;
    return !wildcardDomains.some(
      (wildcard) => domain === wildcard || domain.endsWith(`.${wildcard}`),
    );
  });
}

/** @testonly */
export function renderSquidConfig(request: NetworkBootstrapRequest): {
  readonly config: string;
  readonly domainAclGroups?: readonly SquidDomainAclGroup[];
  readonly blockedErrorPage?: string;
} {
  if (request.fullNetwork) {
    return { config: `${SQUID_COMMON}\nhttp_access allow all\n` };
  }

  const groupedDomains = new Map<
    string,
    { readonly ports: NetworkPortSelection; readonly domains: Set<string> }
  >();
  for (const { host, ports, wildcard } of request.allowNetwork) {
    const key = formatNetworkPortSelection(ports, {
      allPorts: ALL_NETWORK_PORTS,
      separator: ",",
    });
    const group = groupedDomains.get(key) ?? {
      ports,
      domains: new Set<string>(),
    };
    group.domains.add(wildcard ? `.${host}` : host);
    groupedDomains.set(key, group);
  }

  const groups = [...groupedDomains.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group], id) => ({ id, ...group }));
  const aclConfig = groups
    .map(
      ({ id, ports }) =>
        `acl allowed_domains_${id} dstdomain "${getSquidDomainAclPath(id)}"\n` +
        `acl allowed_ports_${id} port ${formatNetworkPortSelection(ports, {
          allPorts: "1-65535",
          separator: " ",
        })}\n` +
        `http_access allow allowed_domains_${id} allowed_ports_${id}`,
    )
    .join("\n\n");
  const domainAclGroups = groups.map(({ id, domains }) => ({
    id,
    content: `${removeDomainsCoveredByWildcard(domains).join("\n")}\n`,
  }));

  return {
    config: `${SQUID_COMMON}\n${aclConfig}${aclConfig ? "\n" : ""}deny_info ERR_SANDBOX_BLOCKED all
error_directory /usr/share/squid/errors/custom
http_access deny all
`,
    domainAclGroups,
    blockedErrorPage: BLOCKED_ERROR_PAGE,
  };
}
