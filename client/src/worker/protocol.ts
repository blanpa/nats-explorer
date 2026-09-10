import type { NatsMessage, WsClientCommand, WsServerEvent } from 'shared';
import type { FlatNode } from '../components/subjects/tree';

export type WsStatus = 'connecting' | 'open' | 'closed';

/** What this tab shows of the subject tree. */
export interface TreeView {
  /** every branch expanded; `paths` are then the collapsed exceptions */
  all: boolean;
  paths: string[];
  filter: string;
  /** CEL expression over the payload; only matching subjects stay in the tree. */
  expr: string;
  hideSystem: boolean;
  /** show the last payload next to each subject; off keeps it off the socket too */
  preview: boolean;
}

/** Messages from the main thread to the feed worker. */
export type ToWorker =
  /** authUrl is resolved on the main thread: a worker has no document to resolve a subpath against. */
  | { type: 'connect'; url: string; binary: boolean; authUrl: string }
  | { type: 'disconnect' }
  | { type: 'send'; cmd: WsClientCommand }
  | { type: 'view'; view: TreeView };

/** Messages from the feed worker to the main thread. */
export type FromWorker =
  | { type: 'status'; status: WsStatus }
  | { type: 'auth-required' }
  /** every server event except the ones the worker consumes itself */
  | { type: 'event'; event: WsServerEvent }
  /** live messages of the focused subject, coalesced, tagged with their connection */
  | { type: 'feed'; msgs: NatsMessage[] }
  /** the rows of the tree as laid out for the current view */
  | { type: 'tree'; rows: FlatNode[]; systemCount: number };
