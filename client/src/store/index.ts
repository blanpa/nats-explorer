import { create } from 'zustand';
import type { ConnectionStatus, HistoryResponse, NatsMessage, SubscriptionStats } from 'shared';
import { applyTheme, readTheme, type Theme } from '../lib/theme';
import { readSetting, writeSetting } from '../lib/utils';
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
}

function countSubjects(stats: Map<string, SubscriptionStats>): number {
  let c = 0;
  for (const st of stats.values()) c += st.subjects;
  return c;
}

const emptyView = (subject: string): LiveView => ({ subject, messages: [], branch: [], loading: true, error: null });

const EXPLORER_WIDTH_KEY = 'ne.explorerWidth';

function readExplorerWidth(): number {
  try {
    const n = Number(localStorage.getItem(EXPLORER_WIDTH_KEY));
    if (n >= 220 && n <= 800) return n;
  } catch {
    /* ignore */
  }
  return 340;
}

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
  connectionsDialog: { open: boolean; editId?: string | null };
  openConnectionsDialog: (editId?: string | null) => void;
  closeConnectionsDialog: () => void;
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
  isExpanded: (path: string) => boolean;
  toggleExpanded: (path: string) => void;
  setExpanded: (paths: Iterable<string>) => void;
  expandAllBranches: () => void;
  collapseAll: () => void;
  /** one live view per selected subject */
  live: Map<string, LiveView>;
  /** feed messages for the selected subjects; called once per animation frame */
  ingestFeed: (msgs: NatsMessage[]) => void;
  /** merge the server history into the live view; ignored when the selection moved on */
  applyHistory: (subject: string, res: HistoryResponse) => void;
  setLiveError: (subject: string, error: string) => void;
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
  explorerWidth: readExplorerWidth(),
  setExplorerWidth: w => {
    const clamped = Math.max(220, Math.min(800, Math.round(w)));
    writeSetting(EXPLORER_WIDTH_KEY, clamped);
    set({ explorerWidth: clamped });
  },
  connectionsDialog: { open: false, editId: null },
  openConnectionsDialog: editId => set({ connectionsDialog: { open: true, editId: editId ?? null } }),
  closeConnectionsDialog: () => set({ connectionsDialog: { open: false, editId: null } }),
  wsOnline: false,
  setWsOnline: b => set({ wsOnline: b }),

  // Subjects ---------------------------------------------------------------
  treeRows: [],
  systemCount: 0,
  setTreeRows: (rows, systemCount) => set({ treeRows: rows, systemCount }),
  subjectFilter: '',
  setSubjectFilter: f => set({ subjectFilter: f }),
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
  isExpanded: path => {
    const s = get();
    return s.expandAll ? !s.expanded.has(path) : s.expanded.has(path);
  },
  toggleExpanded: path =>
    set(s => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  setExpanded: paths => set({ expandAll: false, expanded: new Set(paths) }),
  expandAllBranches: () => set({ expandAll: true, expanded: new Set() }),
  collapseAll: () => set({ expandAll: false, expanded: new Set() }),

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
        updated.messages = merged.length > MAX_SUBJECT_MESSAGES ? merged.slice(merged.length - MAX_SUBJECT_MESSAGES) : merged;
      }
      if (below) {
        const merged = below.reverse().concat(view.branch);
        updated.branch = merged.length > MAX_BRANCH_MESSAGES ? merged.slice(0, MAX_BRANCH_MESSAGES) : merged;
      }
      (next ??= new Map(prev)).set(subject, updated);
    }
    if (next) set({ live: next });
  },
  applyHistory: (subject, res) => {
    const view = get().live.get(subject);
    if (!view) return;
    // The feed may have delivered messages while the request was in flight.
    const seen = new Set(res.messages.map(messageKey));
    const extra = view.messages.filter(m => !seen.has(messageKey(m)));
    let messages = res.messages.concat(extra);
    if (extra.length) messages.sort(byArrival);
    if (messages.length > MAX_SUBJECT_MESSAGES) messages = messages.slice(messages.length - MAX_SUBJECT_MESSAGES);

    const seenBranch = new Set(res.branch.map(messageKey));
    let branch = view.branch.filter(m => !seenBranch.has(messageKey(m))).concat(res.branch);
    if (branch.length !== res.branch.length) branch.sort((a, b) => byArrival(b, a));
    if (branch.length > MAX_BRANCH_MESSAGES) branch = branch.slice(0, MAX_BRANCH_MESSAGES);

    const live = new Map(get().live);
    live.set(subject, { subject, messages, branch, loading: false, error: null });
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
    for (const [subject, v] of get().live) live.set(subject, { ...v, messages: [], branch: [] });
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
