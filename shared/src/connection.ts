export type AuthMethod = 'none' | 'token' | 'userpass' | 'nkey' | 'jwt';

export interface ConnectionConfig {
  id: string;
  name: string;
  servers: string[];
  authMethod: AuthMethod;
  token?: string;
  user?: string;
  pass?: string;
  nkeySeed?: string;
  creds?: string;
  tls?: boolean;
  subscriptions?: string[];
  monitoringPort?: number;
  monitoringUrl?: string;
}

export interface ConnectionStatus {
  connected: boolean;
  server?: string;
  rtt?: number;
  error?: string;
}
