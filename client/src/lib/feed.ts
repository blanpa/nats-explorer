import type { NatsMessage } from 'shared';
import { MAX_BRANCH_MESSAGES, MAX_LOADED_MESSAGES, MAX_SUBJECT_MESSAGES, OLDER_PAGE, useStore } from '../store';
import { api, errorMessage } from './api';
import { wsClient } from './ws';
import { describeEvent, useAlerts } from '../store/alerts';
import { toast } from '../components/ui/Toast';

/**
 * Connects the websocket to the store.
 *
 * The live feed only carries the subject (or branch) this tab focused; the
 * server records everything else. So on every selection change the focus is
 * sent and the recorded history is pulled over REST, and feed batches are
 * coalesced so the store, and with it React, updates at most once per frame.
 */

// Messages that arrived since the last frame. Bounded so a hidden tab does
// not grow without limit.
const MAX_PENDING = 10_000;
let pending: NatsMessage[] = [];
let scheduled = false;

function flush() {
  scheduled = false;
  const batch = pending;
  pending = [];
  useStore.getState().ingestFeed(batch);
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  // requestAnimationFrame pauses in background tabs; keep draining there.
  if (typeof document !== 'undefined' && document.hidden) setTimeout(flush, 250);
  else requestAnimationFrame(flush);
}

/** Queue feed messages (already tagged with their connection) for the next frame. */
export function enqueue(msgs: NatsMessage[]): void {
  for (const m of msgs) pending.push(m);
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  schedule();
}

const loadSeq = new Map<string, number>();

async function loadSubject(subject: string, replace = false): Promise<void> {
  const seq = (loadSeq.get(subject) ?? 0) + 1;
  loadSeq.set(subject, seq);
  try {
    const expr = useStore.getState().subjectExpr.trim() || undefined;
    const res = await api.getHistory(subject, { limit: MAX_SUBJECT_MESSAGES, branchLimit: MAX_BRANCH_MESSAGES, expr });
    if (loadSeq.get(subject) === seq) useStore.getState().applyHistory(subject, res, replace);
  } catch (err) {
    if (loadSeq.get(subject) === seq) useStore.getState().setLiveError(subject, errorMessage(err));
  }
}

/**
 * Pull the recorded history of the selected subjects; stale responses are
 * ignored. By default only views that still wait for it are loaded; `all`
 * refreshes every selected subject (reconnect, subscription change).
 */
export async function loadHistory(all = false, replace = false): Promise<void> {
  const { selectedSubjects, live } = useStore.getState();
  const todo = selectedSubjects.filter(s => all || live.get(s)?.loading);
  await Promise.all(todo.map(s => loadSubject(s, replace)));
}

/**
 * Loads the page of messages before the oldest one this tab holds, so the
 * history grows as it is scrolled instead of stopping at the first request.
 * Sequences count per connection, so every connection that contributed to
 * the view is asked with its own cursor and the pages are merged.
 */
export async function loadOlder(subject: string): Promise<void> {
  const state = useStore.getState();
  const view = state.live.get(subject);
  if (!view || view.loading || view.loadingOlder || view.atOldest) return;
  if (view.messages.length >= MAX_LOADED_MESSAGES) return;
  // The messages are oldest first, so the first of each connection is its
  // cursor. A message without a sequence (a live one that never reached the
  // history) is skipped; the next one only pages over it, it leaves no gap.
  const cursors = new Map<string, number>();
  for (const m of view.messages) {
    if (m.connId && m.sequence !== undefined && !cursors.has(m.connId)) cursors.set(m.connId, m.sequence);
  }
  if (cursors.size === 0) return;
  state.setLoadingOlder(subject, true);
  const expr = state.subjectExpr.trim() || undefined;
  try {
    const pages = await Promise.all(
      [...cursors].map(([connId, before]) => api.getHistory(subject, { connId, before, limit: OLDER_PAGE, branchLimit: 0, expr })),
    );
    // A filter can empty a full page, so the server reports whether it had
    // more before the cursor instead of us counting what came back.
    useStore.getState().prependOlder(
      subject,
      pages.flatMap(p => p.messages),
      pages.every(p => !p.more),
    );
  } catch (err) {
    // The messages already loaded stay: a failed page is not a broken view.
    useStore.getState().setLoadingOlder(subject, false);
    toast.error('Older messages not loaded', errorMessage(err));
  }
}

/**
 * The same for the list of everything below a subject. It merges every
 * subject under the node, so it runs out at its own point and carries its
 * own cursor.
 */
export async function loadOlderBranch(subject: string): Promise<void> {
  const state = useStore.getState();
  const view = state.live.get(subject);
  if (!view || view.loading || view.loadingOlderBranch || view.branchAtOldest) return;
  if (view.branch.length >= MAX_LOADED_MESSAGES) return;
  // Newest first, so the last message of each connection is its oldest.
  const cursors = new Map<string, number>();
  for (const m of view.branch) {
    if (m.connId && m.sequence !== undefined) cursors.set(m.connId, m.sequence);
  }
  if (cursors.size === 0) return;
  state.setLoadingOlderBranch(subject, true);
  const expr = state.subjectExpr.trim() || undefined;
  try {
    const pages = await Promise.all(
      [...cursors].map(([connId, branchBefore]) => api.getHistory(subject, { connId, branchBefore, limit: 1, branchLimit: MAX_BRANCH_MESSAGES, expr })),
    );
    useStore.getState().appendOlderBranch(
      subject,
      pages.flatMap(p => p.branch),
      pages.every(p => !p.branchMore),
    );
  } catch (err) {
    useStore.getState().setLoadingOlderBranch(subject, false);
    toast.error('Older messages not loaded', errorMessage(err));
  }
}

/** Forget the recorded history on the server and in this tab. */
export async function clearHistory(): Promise<void> {
  await api.clearHistory();
  useStore.getState().resetLive();
}

/**
 * Forgets one subject, or a subject and everything below it. The tree loses
 * it as well, so it starts over with the next message.
 */
export async function clearSubject(subject: string, branch: boolean): Promise<number> {
  const res = await api.clearSubjectHistory(subject, { branch });
  const store = useStore.getState();
  if (store.selectedSubjects.some(s => s === subject || (branch && s.startsWith(`${subject}.`)))) {
    store.resetLive();
    await loadHistory(true);
  }
  return res.cleared;
}

function sendFocus() {
  wsClient.send({ type: 'focus', subjects: useStore.getState().selectedSubjects });
}

const connectedIds = (s: ReturnType<typeof useStore.getState>) =>
  s.connections
    .filter(c => c.connected)
    .map(c => c.id)
    .sort()
    .join(',');

const subscriptionKey = (s: ReturnType<typeof useStore.getState>) =>
  s.connections
    .filter(c => c.connected)
    .map(c => `${c.id}=${(c.subscriptions ?? []).join('|')}`)
    .sort()
    .join(',');

const treeView = (s: ReturnType<typeof useStore.getState>) => ({
  all: s.expandAll,
  paths: [...s.expanded],
  filter: s.subjectFilter,
  filterCollapsed: [...s.filterCollapsed],
  expr: s.subjectExpr,
  hideSystem: s.hideSystemSubjects,
  preview: s.treePreview,
});

/** Wire websocket events and selection changes to the store; returns a cleanup. */
export function startFeed(): () => void {
  const store = useStore.getState();
  const unsubs = [
    wsClient.onStatus(status => store.setWsOnline(status === 'open')),
    wsClient.on('connections', e => store.setConnections(e.data)),
    wsClient.onTree((rows, systemCount) => store.setTreeRows(rows, systemCount)),
    wsClient.onFeed(enqueue),
    wsClient.on('stats', e => store.setSubscriptionStats(e.connId, e.data)),
    wsClient.on('filter-error', e => useStore.getState().setFilterError(e.error)),
    // Alerts are evaluated in the backend and pushed; a new one that matters says so once.
    wsClient.on('alerts', e => {
      useAlerts.getState().apply(e.active, e.events);
      for (const ev of e.events ?? []) {
        if (ev.state === 'resolved' || ev.severity === 'info') continue;
        const notify = ev.severity === 'critical' ? toast.error : toast.warning;
        notify(ev.ruleName || 'Alert', describeEvent(ev));
      }
    }),
    // The worker lays the tree out for the view and tells the server which nodes to send.
    useStore.subscribe((s, prev) => {
      if (
        s.expanded !== prev.expanded ||
        s.expandAll !== prev.expandAll ||
        s.filterCollapsed !== prev.filterCollapsed ||
        s.subjectFilter !== prev.subjectFilter ||
        s.subjectExpr !== prev.subjectExpr ||
        s.hideSystemSubjects !== prev.hideSystemSubjects ||
        s.treePreview !== prev.treePreview
      ) {
        wsClient.setView(treeView(s));
      }
    }),
    // Repeated on every (re)connect so a fresh socket streams the right subject
    // and the gap while it was down is filled from the history.
    wsClient.onStatus(status => {
      if (status !== 'open') return;
      sendFocus();
      void loadHistory(true);
    }),
    // The payload filter also narrows what the history endpoints return. The
    // answer replaces the view: a filter that only ever added would never
    // narrow a subject that is already open.
    useStore.subscribe((s, prev) => {
      if (s.subjectExpr !== prev.subjectExpr && s.selectedSubjects.length) void loadHistory(true, true);
    }),
    useStore.subscribe((s, prev) => {
      if (s.selectedSubjects !== prev.selectedSubjects) {
        sendFocus();
        void loadHistory();
      } else if (s.selectedSubjects.length && connectedIds(s) !== connectedIds(prev)) {
        // A connection came or went: its history joins or leaves the view.
        void loadHistory(true);
      } else if (s.selectedSubjects.length && subscriptionKey(s) !== subscriptionKey(prev)) {
        // Subscriptions changed, here or in another tab. What is still
        // covered keeps its history, so only a refresh is needed; a subject
        // that lost its pattern comes back empty.
        void loadHistory(true);
      }
    }),
  ];
  wsClient.setView(treeView(store));
  wsClient.connect();
  return () => {
    for (const u of unsubs) u();
    wsClient.disconnect();
  };
}
