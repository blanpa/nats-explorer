import type { NatsMessage, WsServerEvent } from 'shared';
import { TreeModel, flattenTree, isSystemRoot } from '../components/subjects/tree';
import type { FromWorker, TreeView } from './protocol';

/** Newest live messages kept while the main thread is busy. */
export const MAX_PENDING = 10_000;

/**
 * The part of the feed worker that does not touch the socket: it keeps the
 * subject tree of every connection, lays the rows out for the tab's view
 * and coalesces live messages into one post per frame. Scheduling is
 * injected so tests run it synchronously.
 */
export class FeedCore {
  readonly model = new TreeModel();
  view: TreeView = { all: false, paths: [], filterCollapsed: [], filter: '', expr: '', hideSystem: true, preview: false };
  private knownConns = new Set<string>();
  private pending: NatsMessage[] = [];
  private treeScheduled = false;
  private feedScheduled = false;

  constructor(
    private readonly post: (msg: FromWorker) => void,
    private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => setTimeout(fn, ms),
  ) {}

  /** Handles one decoded server event. */
  handleEvent(msg: WsServerEvent): void {
    switch (msg.type) {
      // Empty slices arrive as null from the Go encoders.
      case 'subject-tree':
        this.model.apply(msg.connId, !!msg.full, msg.data ?? [], msg.removed ?? []);
        this.scheduleTree();
        return;
      case 'message-batch':
        this.queueFeed(msg.connId, msg.data ?? []);
        return;
      case 'connections': {
        msg.data ??= [];
        // Trees of connections that vanished go with them.
        const live = new Set(msg.data.map(c => c.id));
        for (const id of this.knownConns) if (!live.has(id)) this.model.dropConnection(id);
        this.knownConns = live;
        this.scheduleTree();
        this.post({ type: 'event', event: msg });
        return;
      }
      default:
        this.post({ type: 'event', event: msg });
    }
  }

  /** Lays the tree out for the current view and posts the rows. */
  layoutTree(): void {
    this.treeScheduled = false;
    const view = this.view;
    // A filter that names a system root shows system roots regardless of the toggle.
    const wantsSystem = /^\s*[$_]/.test(view.filter);
    const hideSystem = view.hideSystem && !wantsSystem;
    const filtering = view.filter.trim().length > 0;
    const paths = new Set(view.paths);
    // In filter mode the server sends only the paths of matches, so they
    // start open -- typing a filter and seeing nothing but roots would be
    // useless. Open by default is not the same as unclosable, though: a
    // branch the reader collapsed stays collapsed until the filter changes.
    const collapsed = new Set(view.filterCollapsed);
    const isExpanded = filtering ? (p: string) => !collapsed.has(p) : view.all ? (p: string) => !paths.has(p) : (p: string) => paths.has(p);
    const rows = flattenTree(this.model.roots, { isExpanded, hideSystem });
    const systemCount = this.model.roots.filter(n => isSystemRoot(n.segment)).length;
    this.post({ type: 'tree', rows, systemCount });
  }

  /** Clears the tree, e.g. after the socket dropped. */
  reset(): void {
    for (const id of this.knownConns) this.model.dropConnection(id);
    this.knownConns = new Set();
    this.pending = [];
    this.scheduleTree();
  }

  private scheduleTree(): void {
    if (this.treeScheduled) return;
    this.treeScheduled = true;
    this.schedule(() => this.layoutTree(), 0);
  }

  private queueFeed(connId: string, msgs: NatsMessage[]): void {
    for (const m of msgs) this.pending.push({ ...m, connId });
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING);
    if (this.feedScheduled) return;
    this.feedScheduled = true;
    this.schedule(() => this.flushFeed(), 16);
  }

  private flushFeed(): void {
    this.feedScheduled = false;
    const msgs = this.pending;
    this.pending = [];
    this.post({ type: 'feed', msgs });
  }
}
