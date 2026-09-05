import { useMemo } from 'react';
import { create } from 'zustand';
import type { ConnectionStatus, NatsMessage, SubjectNode, SubscriptionStats } from 'shared';
import { applyTheme, readTheme, type Theme } from '../lib/theme';

export type Module = 'subjects' | 'jetstream' | 'kv' | 'objects' | 'services' | 'monitor' | 'cluster';

export const MODULES: { id: Module; label: string; hasExplorer: boolean }[] = [
  { id: 'subjects', label: 'Subjects', hasExplorer: true },
  { id: 'jetstream', label: 'JetStream', hasExplorer: true },
  { id: 'kv', label: 'Key-Value', hasExplorer: true },
  { id: 'objects', label: 'Object Store', hasExplorer: true },
  { id: 'services', label: 'Services', hasExplorer: true },
  { id: 'monitor', label: 'Monitoring', hasExplorer: false },
  { id: 'cluster', label: 'Server', hasExplorer: false },
];

const MAX_MESSAGES_PER_SUBJECT = 500;
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
  subjectTrees: Map<string, SubjectNode[]>;
  setSubjectTree: (connId: string, tree: SubjectNode[]) => void;
  subjectFilter: string;
  setSubjectFilter: (f: string) => void;
  selectedSubject: string | null;
  setSelectedSubject: (s: string | null) => void;
  expanded: Set<string>;
  toggleExpanded: (path: string) => void;
  setExpanded: (paths: Iterable<string>) => void;
  messages: Map<string, NatsMessage[]>;
  messageVersion: number;
  addMessages: (connId: string, msgs: NatsMessage[]) => void;
  clearMessages: (connId?: string) => void;
  selectedMessage: NatsMessage | null;
  setSelectedMessage: (m: NatsMessage | null) => void;
  subscriptionStats: Map<string, SubscriptionStats>;
  setSubscriptionStats: (connId: string, stats: SubscriptionStats) => void;
  totalMessages: number;
  messagesPerSecond: number;
  setMessagesPerSecond: (n: number) => void;
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
  /** bump to ask lists to refetch (e.g. after create/delete in a detail pane) */
  refreshTick: number;
  bumpRefresh: () => void;
}

function countLeaves(nodes: SubjectNode[]): number {
  let c = 0;
  for (const n of nodes) {
    if (n.children.length === 0) c++;
    else c += countLeaves(n.children);
  }
  return c;
}

export const useStore = create<AppState>((set, get) => ({
  // Connections ------------------------------------------------------------
  connections: [],
  activeConnId: null,
  setConnections: conns => {
    const prev = get();
    const stillThere = conns.some(c => c.id === prev.activeConnId);
    const activeConnId = stillThere ? prev.activeConnId : conns.find(c => c.connected)?.id ?? conns[0]?.id ?? null;

    // Drop trees and buffered messages that belong to connections that vanished.
    const live = new Set(conns.map(c => c.id));
    let trees = prev.subjectTrees;
    let messages = prev.messages;
    let stats = prev.subscriptionStats;
    let changed = false;
    for (const id of trees.keys()) {
      if (!live.has(id)) {
        if (!changed) {
          trees = new Map(trees);
          stats = new Map(stats);
          messages = new Map(messages);
          changed = true;
        }
        trees.delete(id);
        stats.delete(id);
        for (const [subject, list] of messages) {
          const kept = list.filter(m => m.connId !== id);
          if (kept.length === 0) messages.delete(subject);
          else if (kept.length !== list.length) messages.set(subject, kept);
        }
      }
    }

    const patch: Partial<AppState> = { connections: conns, activeConnId };
    if (changed) {
      patch.subjectTrees = trees;
      patch.subscriptionStats = stats;
      patch.messages = messages;
      patch.messageVersion = prev.messageVersion + 1;
      let totalSubjects = 0;
      for (const t of trees.values()) totalSubjects += countLeaves(t);
      patch.totalSubjects = totalSubjects;
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
    try {
      localStorage.setItem(EXPLORER_WIDTH_KEY, String(clamped));
    } catch {
      /* ignore */
    }
    set({ explorerWidth: clamped });
  },
  connectionsDialog: { open: false, editId: null },
  openConnectionsDialog: editId => set({ connectionsDialog: { open: true, editId: editId ?? null } }),
  closeConnectionsDialog: () => set({ connectionsDialog: { open: false, editId: null } }),
  wsOnline: false,
  setWsOnline: b => set({ wsOnline: b }),

  // Subjects ---------------------------------------------------------------
  subjectTrees: new Map(),
  setSubjectTree: (connId, tree) => {
    const trees = new Map(get().subjectTrees);
    trees.set(connId, tree);
    let totalSubjects = 0;
    for (const t of trees.values()) totalSubjects += countLeaves(t);
    set({ subjectTrees: trees, totalSubjects });
  },
  subjectFilter: '',
  setSubjectFilter: f => set({ subjectFilter: f }),
  selectedSubject: null,
  setSelectedSubject: subject => set({ selectedSubject: subject, selectedMessage: null }),
  expanded: new Set(),
  toggleExpanded: path =>
    set(s => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  setExpanded: paths => set({ expanded: new Set(paths) }),

  messages: new Map(),
  messageVersion: 0,
  addMessages: (connId, msgs) => {
    if (msgs.length === 0) return;
    const state = get();
    // The map is mutated in place for throughput; messageVersion drives re-renders.
    for (const msg of msgs) {
      const tagged: NatsMessage = { ...msg, connId };
      const list = state.messages.get(msg.subject);
      if (list) {
        list.push(tagged);
        if (list.length > MAX_MESSAGES_PER_SUBJECT) list.splice(0, list.length - MAX_MESSAGES_PER_SUBJECT);
      } else {
        state.messages.set(msg.subject, [tagged]);
      }
    }
    set({ messageVersion: state.messageVersion + 1, totalMessages: state.totalMessages + msgs.length });
  },
  clearMessages: connId => {
    const s = get();
    if (!connId) {
      set({ messages: new Map(), messageVersion: s.messageVersion + 1, totalMessages: 0, selectedMessage: null });
      return;
    }
    const messages = new Map<string, NatsMessage[]>();
    for (const [subject, list] of s.messages) {
      const kept = list.filter(m => m.connId !== connId);
      if (kept.length) messages.set(subject, kept);
    }
    set({ messages, messageVersion: s.messageVersion + 1, selectedMessage: null });
  },
  selectedMessage: null,
  setSelectedMessage: m => set({ selectedMessage: m }),
  subscriptionStats: new Map(),
  setSubscriptionStats: (connId, stats) => {
    const next = new Map(get().subscriptionStats);
    next.set(connId, stats);
    set({ subscriptionStats: next });
  },
  totalMessages: 0,
  messagesPerSecond: 0,
  setMessagesPerSecond: n => set({ messagesPerSecond: n }),
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
  refreshTick: 0,
  bumpRefresh: () => set(s => ({ refreshTick: s.refreshTick + 1 })),
}));

/* Convenience selectors ---------------------------------------------------- */

export const useActiveConnection = () =>
  useStore(s => s.connections.find(c => c.id === s.activeConnId) ?? null);

export const useConnectedCount = () => useStore(s => s.connections.filter(c => c.connected).length);

/**
 * Messages for the selected subject. The underlying array is mutated in place
 * for throughput, so a fresh copy is handed out per batch to keep memo/effect
 * dependencies honest.
 */
export function useSubjectMessages(subject: string | null): NatsMessage[] {
  const version = useStore(s => s.messageVersion);
  const messages = useStore(s => s.messages);
  return useMemo(() => (subject ? (messages.get(subject) ?? EMPTY).slice() : EMPTY), [messages, subject, version]);
}
const EMPTY: NatsMessage[] = [];

/**
 * Recent messages from every subject below a branch (prefix match on
 * `branch.`), newest first. Used when a non-leaf tree node is selected.
 */
export function useBranchMessages(branch: string | null, limit = 200): NatsMessage[] {
  const version = useStore(s => s.messageVersion);
  const messages = useStore(s => s.messages);
  return useMemo(() => {
    if (!branch) return EMPTY;
    const prefix = `${branch}.`;
    const out: NatsMessage[] = [];
    for (const [subject, list] of messages) {
      if (subject.startsWith(prefix)) for (const m of list) out.push(m);
    }
    out.sort((a, b) => b.timestamp - a.timestamp);
    return out.length > limit ? out.slice(0, limit) : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, branch, limit, version]);
}
