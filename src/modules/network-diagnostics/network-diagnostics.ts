export type NetworkConnectionStatus = "ALLOWED" | "BLOCKED";

export interface NetworkDiagnostic {
  output: string;
  error?: string;
}

export interface NetworkLogEntry {
  container: string;
  image: string;
  destination: string;
  dstIp: string;
  port: number;
  count: number;
  lastSeen: number;
  status: NetworkConnectionStatus;
}
