import type { NatsMessage, SubjectEntry, SubscriptionStats } from './messages.js';
import type { ConnectionStatus } from './connection.js';
import type { KvEntry } from './kv.js';
import type { StreamMessage } from './jetstream.js';
import type { Alert, AlertEvent } from './alerts.js';

/** Events pushed from the server over /ws. */
export type WsServerEvent =
  | { type: 'connections'; data: ConnectionStatus[] }
  /** Nodes that appeared or changed in this tab's view; `removed` left it. `full` replaces everything known for the connection. */
  | { type: 'subject-tree'; connId: string; full: boolean; data: SubjectEntry[]; removed?: string[] }
  /** Live messages of the subject or branch this tab focused; nothing else travels on the socket. */
  | { type: 'message-batch'; connId: string; data: NatsMessage[] }
  | { type: 'stats'; connId: string; data: SubscriptionStats }
  | { type: 'kv-update'; connId: string; bucket: string; entry: KvEntry }
  | { type: 'stream-msg'; connId: string; stream: string; message: StreamMessage }
  | { type: 'live-error'; connId: string; bucket?: string; stream?: string; error: string }
  /** The payload filter of this tab's view: an empty error means it compiled. */
  | { type: 'filter-error'; error: string }
  /** Every alert that is currently true, plus the state changes since the last push. */
  | { type: 'alerts'; active: Alert[]; events?: AlertEvent[] };

export type WsEventType = WsServerEvent['type'];
export type WsEventOf<T extends WsEventType> = Extract<WsServerEvent, { type: T }>;

/** Commands the browser sends over /ws to start or stop live watches. */
export type WsClientCommand =
  /** Subjects or branches the user watches; only their messages are streamed to this tab. Empty stops the feed. */
  | { type: 'focus'; subjects: string[] }
  /** Which part of the tree this tab shows: every branch (`all`, `paths` = collapsed exceptions) or the expanded `paths`; a `filter` shows the paths of matching subjects instead. */
  | { type: 'view'; all: boolean; paths: string[]; filter: string; expr?: string; noPreview?: boolean }
  | { type: 'kv-watch'; connId: string; bucket: string; domain?: string }
  | { type: 'kv-unwatch'; connId: string; bucket: string }
  | { type: 'stream-tail'; connId: string; stream: string; domain?: string }
  | { type: 'stream-untail'; connId: string; stream: string };
