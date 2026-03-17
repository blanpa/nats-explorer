import type { NatsMessage, SubjectNode } from './messages.js';
import type { ConnectionStatus } from './connection.js';

export type WsServerEvent =
  | { type: 'message'; data: NatsMessage }
  | { type: 'subject-tree'; data: SubjectNode[] }
  | { type: 'connection-status'; data: ConnectionStatus }
  | { type: 'error'; data: { message: string } };

export type WsClientEvent =
  | { type: 'subscribe'; subject: string }
  | { type: 'unsubscribe'; subject: string }
  | { type: 'subscribe-all' };
