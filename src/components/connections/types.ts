export interface ConnectorStatus {
  id: string;
  kind: string;
  label: string;
  description: string;
  capability: string;
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  connectedAt: string | null;
  /** Custom MCP servers (`kind: "custom_mcp"`): the endpoint, and how many of
   *  its tools Juno may use (null until they have been listed). */
  url?: string;
  toolCount?: number | null;
}
