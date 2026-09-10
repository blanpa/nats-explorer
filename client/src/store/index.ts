import { create } from 'zustand';
import type { ConnectionStatus, HistoryResponse, NatsMessage, SubscriptionStats } from 'shared';
import { applyTheme, readTheme, type Theme } from '../lib/theme';
import { readSetting, writeSetting } from '../lib/utils';
import { appInfo } from '../lib/storage';
import { byArrival, messageKey } from '../lib/messages';
import { clearAsyncCache } from '../lib/useAsync';
import { ancestorsOf, type FlatNode } from '../components/subjects/tree';

export type Module = 'subjects' | 'jetstream' | 'kv' | 'objects' | 'services' | 'requests' | 'monitor' | 'cluster' | 'alerts' | 'audit';

export const MODULES: { id: Module; label: string; hasExplorer: boolean }[] = [
  { id: 'subjects', label: 'Subjects', hasExplorer: true },
  { id: 'jetstream', label: 'JetStream', hasExplorer: true },
  { id: 'kv', label: 'Key-Value', hasExplorer: true },
  { id: 'objects', label: 'Object Store', hasExplorer: true },
  { id: 'services', label: 'Services', hasExplorer: true },
  { id: 'requests', label: 'Requests', hasExplorer: true },
  { id: 'monitor', label: 'Monitoring', hasExplorer: false },
  { id: 'cluster', label: 'Cluster', hasExplorer: false },
  { id: 'alerts', label: 'Alerts', hasExplorer: false },
  { id: 'audit', label: 'Audit log', hasExplorer: false },
];

/** How many messages of the selected subject the browser keeps (history + live). */
export const MAX_SUBJECT_MESSAGES = 1000;
/**
 * The ceiling the view may grow to by paging backwards. It matches what the
 * server keeps per subject in memory, and bounds the tab's heap: every
 * message is held with its payload.
 */
export const MAX_LOADED_MESSAGES = 10000;
/** How many older messages one page brings in. */
export const OLDER_PAGE = 500;
/** How many messages below a selected branch the browser keeps, newest first. */
export const MAX_BRANCH_MESSAGES = 200;

/**
 * What the user looks at: the selected subject, what the server recorded for
 * it, and what arrived on the feed since. The only messages the browser holds.
 */
export interface LiveView {
  subject: string;
  /** messages on exactly the subject, oldest first */
  messages: NatsMessage[];
  /** newest messages on subjects below it, newest first */
  branch: NatsMessage[];
  /** history request in flight */
  loading: boolean;
  error: string | null;
  /**
   * How many messages this view may hold. It starts at MAX_SUBJECT_MESSAGES
   * and grows with every page of older messages loaded, so the live feed
   * does not push what was fetched back out again.
   */
  cap: number;
  /** a page of older messages is on its way */
  loadingOlder: boolean;
  /** the server has nothing older than what is loaded */
  atOldest: boolean;
  /** the same three for the list of everything below the subject */
  branchCap: number;
  loadingOlderBranch: boolean;
  branchAtOldest: boolean;
}

function countSubjects(stats: Map<string, SubscriptionStats>): number {
  let c = 0;
  for (const st of stats.values()) c += st.subjects;
  return c;
}

const emptyView = (subject: string): LiveView => ({
  subject,
  messages: [],
  branch: [],
  loading: true,
  error: null,
  cap: MAX_SUBJECT_MESSAGES,
  loadingOlder: false,
  atOldest: false,
  branchCap: MAX_BRANCH_MESSAGES,
  loadingOlderBranch: false,
  branchAtOldest: false,
});

const EXPLORER_WIDTH_KEY = 'ne.explorerWidth';
const HISTORY_RAIL_WIDTH_KEY = 'ne.historyRailWidth';

/** Bounds of the resizable panes: [min, max, default]. */
export const EXPLORER_WIDTH = [220, 800, 340] as const;
export const HISTORY_RAIL_WIDTH = [180, 800, 288] as const;

/** A stored pane width, or the default when it is missing or out of bounds. */
export function readWidth(key: string, [min, max, fallback]: readonly [number, number, number]): number {
  try {
    const n = Number(localStorage.getItem(key));
    if (n >= min && n <= max) return n;
  } catch {
    /* private mode, cleared storage */
  }
  return fallback;
}

const clampWidth = (w: number, [min, max]: readonly [number, number, number]) => Math.max(min, Math.min(max, Math.round(w)));

export interface AppState {
  // Connections
  connections: ConnectionStatus[];
  /** false until the backend has reported its connection list once; avoids flashing "Not connected" */
  connectionsLoaded: boolean;
  activeConnId: string | null;
  setConnections: (conns: ConnectionStatus[]) => void;
  setActiveConnId: (id: string | null) => void;

  // Shell
  module: Module;
  setModule: (m: Module) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  explorerWidth: number;
  setExplorerWidth: (w: number) => void;
  /** width of the history rail in the subject detail */
  historyRailWidth: number;
  setHistoryRailWidth: (w: number) => void;
  connectionsDialog: { open: boolean; editId?: string | null };
  openConnectionsDialog: (editId?: string | null) => void;
  closeConnectionsDialog: () => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** the backend also writes the history to SQLite, so time ranges beyond
   * memory can be queried. A setting, so it changes while the app runs. */
  historyDb: boolean;
  /** how far back that copy reaches, as a Go duration */
  historyRetention: string;
  setHistoryDb: (enabled: boolean, retention: string) => void;
  wsOnline: boolean;
  setWsOnline: (b: boolean) => void;

  // Subjects / live feed
  /** rows of the subject tree as laid out by the feed worker for the current view */
  treeRows: FlatNode[];
  /** system roots ($…, _INBOX) the server knows of, shown or hidden */
  systemCount: number;
  setTreeRows: (rows: FlatNode[], systemCount: number) => void;
  subjectFilter: string;
  setSubjectFilter: (f: string) => void;
  /** CEL expression over the payload; narrows the tree and the history queries */
  subjectExpr: string;
  setSubjectExpr: (e: string) => void;
  /** why the payload filter did not compile, from the server */
  filterError: string | null;
  setFilterError: (e: string) => void;
  /** hide _INBOX and $-prefixed roots (JetStream API, KV/object internals, system events) */
  hideSystemSubjects: boolean;
  setHideSystemSubjects: (b: boolean) => void;
  /**
   * Show the last payload next to each subject in the tree. Off by default:
   * the tree is for counts and rates, and the preview is the largest part of
   * every entry on the socket -- switched off it is not sent at all.
   */
  treePreview: boolean;
  setTreePreview: (b: boolean) => void;
  /** subjects watched at once (Ctrl/Cmd-click in the tree); the last one is `selectedSubject` */
  selectedSubjects: string[];
  selectedSubject: string | null;
  /** replaces the selection */
  setSelectedSubject: (s: string | null) => void;
  /** Selects a subject and opens the branches above it, so it is visible in the tree. */
  revealSubject: (s: string) => void;
  /** adds or removes a subject from the selection */
  toggleSelectedSubject: (s: string) => void;
  /** every branch expanded; `expanded` then holds the collapsed exceptions */
  expandAll: boolean;
  expanded: Set<string>;
  /**
   * While a filter is on every match is shown, so `expanded` says nothing:
   * the branches closed by hand are kept here instead, and forgotten when
   * the filter changes.
   */
  filterCollapsed: Set<string>;
  isExpanded: (path: string) => boolean;
  toggleExpanded: (path: string) => void;
  setExpanded: (paths: Iterable<string>) => void;
  expandAllBranches: () => void;
  collapseAll: () => void;
  /** one live view per selected subject */
  live: Map<string, LiveView>;
  /** feed messages for the selected subjects; called once per animation frame */
  ingestFeed: (msgs: NatsMessage[]) => void;
  /**
   * Merge the server history into the live view; ignored when the selection
   * moved on. With replace the answer is the whole truth -- a narrowed
   * payload filter has to be able to take messages away, not only add.
   */
  applyHistory: (subject: string, res: HistoryResponse, replace?: boolean) => void;
  setLiveError: (subject: string, error: string) => void;
  /** a page of older messages is being fetched */
  setLoadingOlder: (subject: string, loading: boolean) => void;
  /** put a page of older messages in front; `atOldest` when the server had no more */
  prependOlder: (subject: string, msgs: NatsMessage[], atOldest: boolean) => void;
  /** the same for the list below the subject, which is newest first */
  setLoadingOlderBranch: (subject: string, loading: boolean) => void;
  appendOlderBranch: (subject: string, msgs: NatsMessage[], atOldest: boolean) => void;
  /** forget buffered messages, keep the selection */
  resetLive: () => void;
  selectedMessage: NatsMessage | null;
  setSelectedMessage: (m: NatsMessage | null) => void;
  subscriptionStats: Map<string, SubscriptionStats>;
  setSubscriptionStats: (connId: string, stats: SubscriptionStats) => void;
  totalSubjects: number;
  publishOpen: boolean;
  setPublishOpen: (b: boolean) => void;
  publishPrefill: { subject: string; payload?: string } | null;
  prefillPublish: (p: { subject: string; payload?: string } | null) => void;

  // Module selections
  selectedStream: string | null;
  setSelectedStream: (s: string | null) => void;
  selectedKvBucket: string | null;
  setSelectedKvBucket: (s: string | null) => void;
  selectedObjStore: string | null;
  setSelectedObjStore: (s: string | null) => void;
  selectedService: string | null;
  setSelectedService: (s: string | null) => void;
  selectedTemplateId: string | null;
  setSelectedTemplateId: (id: string | null) => void;
  /** bump to ask lists to refetch (e.g. after create/delete in a detail pane) */
  refreshTick: number;
  bumpRefresh: () => void;
  /** per connection: JetStream domain used instead of the connection's default */
  jsDomainOverride: Map<string, string>;
  setJsDomainOverride: (connId: string, domain: string) => void;
}

export const useStore = create<AppState>((set, get) => ({
  // Connections ------------------------------------------------------------
  connections: [],
  connectionsLoaded: false,
  activeConnId: null,
  setConnections: conns => {
    const prev = get();
    const stillThere = conns.some(c => c.id === prev.activeConnId);
    const activeConnId = stillThere ? prev.activeConnId : (conns.find(c => c.connected)?.id ?? conns[0]?.id ?? null);

    // Drop counters and buffered messages that belong to connections that vanished.
    const live = new Set(conns.map(c => c.id));
    let stats = prev.subscriptionStats;
    let changed = false;
    for (const id of stats.keys()) {
      if (!live.has(id)) {
        if (!changed) {
          stats = new Map(stats);
          changed = true;
        }
        stats.delete(id);
      }
    }

    const patch: Partial<AppState> = { connections: conns, activeConnId, connectionsLoaded: true };
    if (changed) {
      patch.subscriptionStats = stats;
      patch.totalSubjects = countSubjects(stats);
      if (prev.live.size) {
        const keep = (m: NatsMessage) => !m.connId || live.has(m.connId);
        patch.live = new Map([...prev.live].map(([subject, v]) => [subject, { ...v, messages: v.messages.filter(keep), branch: v.branch.filter(keep) }]));
      }
    }
    if (activeConnId !== prev.activeConnId) {
      patch.selectedStream = null;
      patch.selectedKvBucket = null;
      patch.selectedObjStore = null;
      patch.selectedService = null;
    }
    set(patch);
  },
  setActiveConnId: id =>
    set(s => (s.activeConnId === id ? {} : { activeConnId: id, selectedStream: null, selectedKvBucket: null, selectedObjStore: null, selectedService: null })),

  // Shell ------------------------------------------------------------------
  module: 'subjects',
  setModule: m => set({ module: m }),
  theme: readTheme(),
  setTheme: t => {
    applyTheme(t);
    set({ theme: t });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
  explorerWidth: readWidth(EXPLORER_WIDTH_KEY, EXPLORER_WIDTH),
  setExplorerWidth: w => {
    const clamped = clampWidth(w, EXPLORER_WIDTH);
    writeSetting(EXPLORER_WIDTH_KEY, clamped);
    set({ explorerWidth: clamped });
  },
  historyRailWidth: readWidth(HISTORY_RAIL_WIDTH_KEY, HISTORY_RAIL_WIDTH),
  setHistoryRailWidth: w => {
    const clamped = clampWidth(w, HISTORY_RAIL_WIDTH);
    writeSetting(HISTORY_RAIL_WIDTH_KEY, clamped);
    set({ historyRailWidth: clamped });
  },
  connectionsDialog: { open: false, editId: null },
  openConnectionsDialog: editId => set({ connectionsDialog: { open: true, editId: editId ?? null } }),
  closeConnectionsDialog: () => set({ connectionsDialog: { open: false, editId: null } }),
  settingsOpen: false,
  setSettingsOpen: open => set({ settingsOpen: open }),
  historyDb: appInfo.historyDb ?? false,
  historyRetention: appInfo.historyRetention ?? '',
  setHistoryDb: (enabled, retention) => {
    // Keep appInfo in step: components that read it directly (and the next
    // hydration) should not disagree with the store.
    appInfo.historyDb = enabled;
    appInfo.historyRetention = retention;
    set({ historyDb: enabled, historyRetention: retention });
  },
  wsOnline: false,
  setWsOnline: b => set({ wsOnline: b }),

  // Subjects ---------------------------------------------------------------
  treeRows: [],
  systemCount: 0,
  setTreeRows: (rows, systemCount) => set({ treeRows: rows, systemCount }),
  subjectFilter: '',
  // A new filter is a new set of matches, so what was closed under the old
  // one means nothing under it.
  setSubjectFilter: f => set({ subjectFilter: f, filterCollapsed: new Set() }),
  subjectExpr: readSetting('ne.subjectExpr', ''),
  setSubjectExpr: e => {
    writeSetting('ne.subjectExpr', e);
    set({ subjectExpr: e, ...(e.trim() ? {} : { filterError: null }) });
  },
  filterError: null,
  setFilterError: e => set({ filterError: e || null }),
  hideSystemSubjects: readSetting('ne.hideSystemSubjects', true),
  setHideSystemSubjects: b => {
    writeSetting('ne.hideSystemSubjects', b);
    set({ hideSystemSubjects: b });
  },
  treePreview: readSetting('ne.treePreview', false),
  setTreePreview: b => {
    writeSetting('ne.treePreview', b);
    set({ treePreview: b });
  },
  selectedSubjects: [],
  selectedSubject: null,
  setSelectedSubject: subject =>
    set(s => {
      if (s.selectedSubject === subject && s.selectedSubjects.length <= 1) return {};
      const live = new Map<string, LiveView>();
      if (subject) live.set(subject, s.live.get(subject) ?? emptyView(subject));
      return { selectedSubjects: subject ? [subject] : [], selectedSubject: subject, selectedMessage: null, live };
    }),
  revealSubject: subject => {
    const s = get();
    // With "expand all" the set holds the collapsed exceptions, so revealing
    // means removing the ancestors from it instead of adding them.
    const next = new Set(s.expanded);
    for (const path of ancestorsOf(subject)) {
      if (s.expandAll) next.delete(path);
      else next.add(path);
    }
    set({ expanded: next });
    s.setSelectedSubject(subject);
  },
  toggleSelectedSubject: subject =>
    set(s => {
      const live = new Map(s.live);
      let selectedSubjects: string[];
      if (s.selectedSubjects.includes(subject)) {
        selectedSubjects = s.selectedSubjects.filter(x => x !== subject);
        live.delete(subject);
      } else {
        selectedSubjects = [...s.selectedSubjects, subject];
        live.set(subject, emptyView(subject));
      }
      return { selectedSubjects, selectedSubject: selectedSubjects[selectedSubjects.length - 1] ?? null, selectedMessage: null, live };
    }),
  expandAll: false,
  expanded: new Set(),
  filterCollapsed: new Set(),
  isExpanded: path => {
    const s = get();
    if (s.subjectFilter.trim()) return !s.filterCollapsed.has(path);
    return s.expandAll ? !s.expanded.has(path) : s.expanded.has(path);
  },
  toggleExpanded: path =>
    set(s => {
      // A filter decides what is shown, so a toggle under one is about that
      // view alone and must not disturb the expansion the reader had before.
      if (s.subjectFilter.trim()) {
        const next = new Set(s.filterCollapsed);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return { filterCollapsed: next };
      }
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  setExpanded: paths => set({ expandAll: false, expanded: new Set(paths) }),
  expandAllBranches: () => set(s => (s.subjectFilter.trim() ? { filterCollapsed: new Set() } : { expandAll: true, expanded: new Set() })),
  collapseAll: () =>
    set(s => {
      if (!s.subjectFilter.trim()) return { expandAll: false, expanded: new Set() };
      // Under a filter there are no roots to fall back to, so collapsing
      // everything means closing every branch that is on screen.
      return { filterCollapsed: new Set(s.treeRows.filter(r => r.hasChildren).map(r => r.subject)) };
    }),

  live: new Map(),
  ingestFeed: msgs => {
    const prev = get().live;
    if (prev.size === 0 || msgs.length === 0) return;
    let next: Map<string, LiveView> | null = null;
    for (const [subject, view] of prev) {
      const prefix = `${subject}.`;
      let exact: NatsMessage[] | null = null;
      let below: NatsMessage[] | null = null;
      for (const m of msgs) {
        if (m.subject === subject) (exact ??= []).push(m);
        else if (m.subject.startsWith(prefix)) (below ??= []).push(m);
      }
      if (!exact && !below) continue;
      const updated = { ...view };
      if (exact) {
        const merged = view.messages.concat(exact);
        updated.messages = merged.length > view.cap ? merged.slice(merged.length - view.cap) : merged;
      }
      if (below) {
        const merged = below.reverse().concat(view.branch);
        updated.branch = merged.length > view.branchCap ? merged.slice(0, view.branchCap) : merged;
      }
      (next ??= new Map(prev)).set(subject, updated);
    }
    if (next) set({ live: next });
  },
  applyHistory: (subject, res, replace) => {
    const view = get().live.get(subject);
    if (!view) return;
    // The feed may have delivered messages while the request was in flight,
    // so they are kept -- unless the caller says the answer replaces the
    // view, which is what a changed payload filter needs.
    const seen = new Set(res.messages.map(messageKey));
    const extra = replace ? [] : view.messages.filter(m => !seen.has(messageKey(m)));
    let messages = res.messages.concat(extra);
    if (extra.length) messages.sort(byArrival);
    if (messages.length > MAX_SUBJECT_MESSAGES) messages = messages.slice(messages.length - MAX_SUBJECT_MESSAGES);

    const seenBranch = new Set(res.branch.map(messageKey));
    let branch = replace ? res.branch : view.branch.filter(m => !seenBranch.has(messageKey(m))).concat(res.branch);
    if (branch.length !== res.branch.length) branch.sort((a, b) => byArrival(b, a));
    if (branch.length > MAX_BRANCH_MESSAGES) branch = branch.slice(0, MAX_BRANCH_MESSAGES);

    const live = new Map(get().live);
    // A fresh history starts the paging over: the cap is back to one page.
    live.set(subject, {
      ...view,
      subject,
      messages,
      branch,
      loading: false,
      error: null,
      cap: MAX_SUBJECT_MESSAGES,
      loadingOlder: false,
      atOldest: false,
      branchCap: MAX_BRANCH_MESSAGES,
      loadingOlderBranch: false,
      branchAtOldest: false,
    });
    set({ live });
  },
  setLoadingOlder: (subject, loading) => {
    const view = get().live.get(subject);
    if (!view || view.loadingOlder === loading) return;
    const live = new Map(get().live);
    live.set(subject, { ...view, loadingOlder: loading });
    set({ live });
  },
  setLoadingOlderBranch: (subject, loading) => {
    const view = get().live.get(subject);
    if (!view || view.loadingOlderBranch === loading) return;
    const live = new Map(get().live);
    live.set(subject, { ...view, loadingOlderBranch: loading });
    set({ live });
  },
  appendOlderBranch: (subject, msgs, atOldest) => {
    const view = get().live.get(subject);
    if (!view) return;
    const seen = new Set(view.branch.map(messageKey));
    const older = msgs.filter(m => !seen.has(messageKey(m)));
    // Newest first here, so an older page goes to the end.
    const branch = older.length ? view.branch.concat(older).sort((a, b) => byArrival(b, a)) : view.branch;
    const branchCap = Math.min(MAX_LOADED_MESSAGES, Math.max(view.branchCap, branch.length + MAX_BRANCH_MESSAGES));
    const live = new Map(get().live);
    live.set(subject, {
      ...view,
      branch: branch.length > branchCap ? branch.slice(0, branchCap) : branch,
      branchCap,
      loadingOlderBranch: false,
      branchAtOldest: atOldest || branch.length >= MAX_LOADED_MESSAGES,
    });
    set({ live });
  },
  prependOlder: (subject, msgs, atOldest) => {
    const view = get().live.get(subject);
    if (!view) return;
    const seen = new Set(view.messages.map(messageKey));
    const older = msgs.filter(m => !seen.has(messageKey(m)));
    // Pages of different connections interleave, so the whole list is
    // sorted rather than assumed to be in order.
    const messages = older.length ? older.concat(view.messages).sort(byArrival) : view.messages;
    // The cap keeps a page of headroom above what is loaded, so live traffic
    // fills that first instead of dropping the page just fetched.
    const cap = Math.min(MAX_LOADED_MESSAGES, Math.max(view.cap, messages.length + MAX_SUBJECT_MESSAGES));
    const live = new Map(get().live);
    live.set(subject, {
      ...view,
      messages: messages.length > cap ? messages.slice(messages.length - cap) : messages,
      cap,
      loadingOlder: false,
      atOldest: atOldest || messages.length >= MAX_LOADED_MESSAGES,
    });
    set({ live });
  },
  setLiveError: (subject, error) => {
    const view = get().live.get(subject);
    if (!view) return;
    const live = new Map(get().live);
    live.set(subject, { ...view, loading: false, error });
    set({ live });
  },
  resetLive: () => {
    const live = new Map<string, LiveView>();
    for (const [subject, v] of get().live)
      live.set(subject, { ...v, messages: [], branch: [], cap: MAX_SUBJECT_MESSAGES, atOldest: false, branchCap: MAX_BRANCH_MESSAGES, branchAtOldest: false });
    set({ live, selectedMessage: null });
  },
  selectedMessage: null,
  setSelectedMessage: m => set({ selectedMessage: m }),
  subscriptionStats: new Map(),
  setSubscriptionStats: (connId, stats) => {
    const next = new Map(get().subscriptionStats);
    next.set(connId, stats);
    set({ subscriptionStats: next, totalSubjects: countSubjects(next) });
  },
  totalSubjects: 0,
  publishOpen: false,
  setPublishOpen: b => set({ publishOpen: b }),
  publishPrefill: null,
  prefillPublish: p => set({ publishPrefill: p, publishOpen: p ? true : get().publishOpen }),

  // Module selections --------------------------------------------------------
  selectedStream: null,
  setSelectedStream: s => set({ selectedStream: s }),
  selectedKvBucket: null,
  setSelectedKvBucket: s => set({ selectedKvBucket: s }),
  selectedObjStore: null,
  setSelectedObjStore: s => set({ selectedObjStore: s }),
  selectedService: null,
  setSelectedService: s => set({ selectedService: s }),
  selectedTemplateId: null,
  setSelectedTemplateId: id => set({ selectedTemplateId: id }),
  refreshTick: 0,
  bumpRefresh: () => set(s => ({ refreshTick: s.refreshTick + 1 })),
  jsDomainOverride: new Map(),
  setJsDomainOverride: (connId, domain) => {
    const next = new Map(get().jsDomainOverride);
    if (domain.trim()) next.set(connId, domain.trim());
    else next.delete(connId);
    clearAsyncCache();
    set(s => ({ jsDomainOverride: next, refreshTick: s.refreshTick + 1, selectedStream: null, selectedKvBucket: null, selectedObjStore: null }));
  },
}));

/** Domain override for a connection, or undefined when the connection default applies. */
export const useJsDomainOverride = (connId: string | null) => useStore(s => (connId ? s.jsDomainOverride.get(connId) : undefined));

/* Convenience selectors ---------------------------------------------------- */

export const useActiveConnection = () => useStore(s => s.connections.find(c => c.id === s.activeConnId) ?? null);

const EMPTY: NatsMessage[] = [];

/** Messages on exactly a selected subject, oldest first. */
export const useSubjectMessages = (subject: string | null): NatsMessage[] => useStore(s => (subject ? s.live.get(subject)?.messages : undefined) ?? EMPTY);

/** Newest messages below a selected subject, newest first. */
export const useBranchMessages = (subject: string | null): NatsMessage[] => useStore(s => (subject ? s.live.get(subject)?.branch : undefined) ?? EMPTY);

/** The live view of a selected subject, if any. */
export const useLiveView = (subject: string | null): LiveView | undefined => useStore(s => (subject ? s.live.get(subject) : undefined));
