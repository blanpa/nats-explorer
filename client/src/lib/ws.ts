import type { WsClientCommand, WsEventOf, WsEventType, WsServerEvent, NatsMessage } from 'shared';
import type { FlatNode } from '../components/subjects/tree';
import type { FromWorker, ToWorker, TreeView, WsStatus } from '../worker/protocol';
import { useAuth } from './auth';
import { readSetting } from './utils';

export type { WsStatus, TreeView };

type Listener<T extends WsEventType> = (event: WsEventOf<T>) => void;
type StatusListener = (status: WsStatus) => void;

/**
 * Main-thread side of the websocket. The socket itself lives in the feed
 * worker (see worker/feed.worker.ts), which decodes frames, keeps the subject
 * tree and coalesces live messages; this class relays commands to it and
 * fans its messages out to listeners. Commands sent while the socket is down
 * are dropped; callers re-issue them on the next 'open' status.
 */
class WsClient {
  private worker: Worker | null = null;
  private listeners = new Map<WsEventType, Set<(event: WsServerEvent) => void>>();
  private statusListeners = new Set<StatusListener>();
  private treeListeners = new Set<(rows: FlatNode[], systemCount: number) => void>();
  private feedListeners = new Set<(msgs: NatsMessage[]) => void>();
  private view: TreeView | null = null;
  status: WsStatus = 'closed';

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('../worker/feed.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(ev.data);
    this.worker = worker;
    if (this.view) this.post({ type: 'view', view: this.view });
    return worker;
  }

  private post(msg: ToWorker) {
    this.ensureWorker().postMessage(msg);
  }

  private handle(msg: FromWorker) {
    switch (msg.type) {
      case 'status':
        this.setStatus(msg.status);
        break;
      case 'auth-required':
        useAuth.getState().setRequired(true);
        break;
      case 'event':
        for (const cb of this.listeners.get(msg.event.type) ?? []) cb(msg.event);
        break;
      case 'feed':
        for (const cb of this.feedListeners) cb(msg.msgs);
        break;
      case 'tree':
        for (const cb of this.treeListeners) cb(msg.rows, msg.systemCount);
        break;
    }
  }

  private url(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  connect(): void {
    // ne.wire = "json" switches the frames back to JSON, e.g. to compare.
    const binary = readSetting<string>('ne.wire', 'msgpack') !== 'json';
    this.post({ type: 'connect', url: this.url(), binary });
  }

  disconnect(): void {
    if (this.worker) this.post({ type: 'disconnect' });
    this.setStatus('closed');
  }

  /** Reconnect now (e.g. after a token was entered). */
  reset(): void {
    this.disconnect();
    this.connect();
  }

  send(cmd: WsClientCommand): boolean {
    if (this.status !== 'open') return false;
    this.post({ type: 'send', cmd });
    return true;
  }

  /** Tell the worker (and through it the server) what part of the tree to show. */
  setView(view: TreeView): void {
    this.view = view;
    this.post({ type: 'view', view });
  }

  on<T extends WsEventType>(type: T, callback: Listener<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const cb = callback as unknown as (event: WsServerEvent) => void;
    set.add(cb);
    return () => set!.delete(cb);
  }

  onTree(callback: (rows: FlatNode[], systemCount: number) => void): () => void {
    this.treeListeners.add(callback);
    return () => this.treeListeners.delete(callback);
  }

  onFeed(callback: (msgs: NatsMessage[]) => void): () => void {
    this.feedListeners.add(callback);
    return () => this.feedListeners.delete(callback);
  }

  onStatus(callback: StatusListener): () => void {
    this.statusListeners.add(callback);
    callback(this.status);
    return () => this.statusListeners.delete(callback);
  }

  private setStatus(status: WsStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusListeners) cb(status);
  }
}

export const wsClient = new WsClient();
