import type { NatsMessage, SubjectNode, SubscriptionStats } from './messages.js';
import type { ConnectionStatus } from './connection.js';
import type { KvEntry } from './kv.js';
import type { StreamMessage } from './jetstream.js';

/** Events pushed from the server over /ws. */
export type WsServerEvent =
  | { type: 'connections'; data: ConnectionStatus[] }
  | { type: 'subject-tree'; connId: string; data: SubjectNode[] }
  | { type: 'message-batch'; connId: string; data: NatsMessage[]; stats: SubscriptionStats }
  | { type: 'kv-update'; connId: string; bucket: string; entry: KvEntry }
  | { type: 'stream-msg'; connId: string; stream: string; message: StreamMessage }
  | { type: 'live-error'; connId: string; bucket?: string; stream?: string; error: string };

export type WsEventType = WsServerEvent['type'];
export type WsEventOf<T extends WsEventType> = Extract<WsServerEvent, { type: T }>;

/** Commands the browser sends over /ws to start or stop live watches. */
export type WsClientCommand =
  | { type: 'kv-watch'; connId: string; bucket: string }
  | { type: 'kv-unwatch'; connId: string; bucket: string }
  | { type: 'stream-tail'; connId: string; stream: string }
  | { type: 'stream-untail'; connId: string; stream: string };
