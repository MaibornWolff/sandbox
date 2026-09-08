import * as dns from "node:dns/promises";
import { isIP } from "node:net";

export function isIpAddress(value: string): boolean {
  return isIP(value) !== 0;
}

export function reverseDns(ip: string): Promise<string[]> {
  return dns.reverse(ip);
}
