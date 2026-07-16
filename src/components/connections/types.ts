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
}
