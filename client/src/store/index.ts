import { create } from 'zustand';

export interface SubjectNode {
  segment: string;
  fullSubject: string;
  messageCount: number;
  lastMessage?: any;
  children: SubjectNode[];
  rate: number;
}

export interface NatsMessage {
  subject: string;
  payload: string;
  payloadType: 'string' | 'json' | 'binary';
  headers?: Record<string, string[]>;
  timestamp: number;
  reply?: string;
  size: number;
  sequence?: number;
  connId?: string;
}

export interface ConnectionInfo {
  id: string;
  name: string;
  connected: boolean;
  server?: string;
  color: string;
  servers?: string[];
  subscriptions?: string[];
}

export type ActiveTab = 'subjects' | 'jetstream' | 'kv' | 'objectstore' | 'cluster' | 'monitor' | 'services';
export type Theme = 'dark' | 'light';

interface AppState {
  // Connections (multiple)
  connections: ConnectionInfo[];
  activeConnId: string | null;
  setConnections: (conns: ConnectionInfo[]) => void;
  setActiveConnId: (id: string | null) => void;
  updateConnection: (connId: string, status: Partial<ConnectionInfo>) => void;
  removeConnection: (connId: string) => void;

  // Subjects (per connection)
  subjectTrees: Map<string, SubjectNode[]>;
  selectedSubject: string | null;
  subjectFilter: string;
  setSubjectTree: (connId: string, tree: SubjectNode[]) => void;
  setSelectedSubject: (subject: string | null) => void;
  setSubjectFilter: (filter: string) => void;

  // Messages
  messages: Map<string, NatsMessage[]>;
  selectedMessage: NatsMessage | null;
  addMessage: (connId: string, msg: NatsMessage) => void;
  setSelectedMessage: (msg: NatsMessage | null) => void;
  clearMessages: () => void;

  // UI
  activeTab: ActiveTab;
  theme: Theme;
  publishPanelOpen: boolean;
  setActiveTab: (tab: ActiveTab) => void;
  toggleTheme: () => void;
  setPublishPanelOpen: (open: boolean) => void;

  // Stats
  totalMessages: number;
  messagesPerSecond: number;
  totalSubjects: number;

  // Cluster info
  clusterInfo: any;
  setClusterInfo: (info: any) => void;

  // Store-level selections for JetStream/KV/ObjStore (used by sidebar -> detail communication)
  _selectedStream: string | null;
  _selectedKvBucket: string | null;
  _selectedObjStore: string | null;
}

const MAX_MESSAGES_PER_SUBJECT = 500;

export const useStore = create<AppState>((set, get) => ({
  // Connections
  connections: [],
  activeConnId: null,
  setConnections: (conns) => set({ connections: conns, activeConnId: conns.length > 0 ? (get().activeConnId || conns[0].id) : null }),
  setActiveConnId: (id) => set({ activeConnId: id }),
  updateConnection: (connId, status) => set(s => ({
    connections: s.connections.map(c => c.id === connId ? { ...c, ...status } : c),
  })),
  removeConnection: (connId) => set(s => ({
    connections: s.connections.filter(c => c.id !== connId),
    activeConnId: s.activeConnId === connId ? (s.connections.find(c => c.id !== connId)?.id || null) : s.activeConnId,
  })),

  // Subjects
  subjectTrees: new Map(),
  selectedSubject: null,
  subjectFilter: '',
  setSubjectTree: (connId, tree) => {
    const newTrees = new Map(get().subjectTrees);
    newTrees.set(connId, tree);
    // Count total subjects across all connections
    let totalSubjects = 0;
    for (const t of newTrees.values()) {
      const count = (nodes: SubjectNode[]): number => {
        let c = 0;
        for (const n of nodes) { if (!n.children.length) c++; c += count(n.children); }
        return c;
      };
      totalSubjects += count(t);
    }
    set({ subjectTrees: newTrees, totalSubjects });
  },
  setSelectedSubject: (subject) => set({ selectedSubject: subject }),
  setSubjectFilter: (filter) => set({ subjectFilter: filter }),

  // Messages
  messages: new Map(),
  selectedMessage: null,
  addMessage: (connId, msg) => {
    const state = get();
    const tagged = { ...msg, connId };
    // Mutate in place for performance -- avoid cloning entire Map per message
    const existing = state.messages.get(msg.subject);
    if (existing) {
      existing.push(tagged);
      if (existing.length > MAX_MESSAGES_PER_SUBJECT) {
        existing.splice(0, existing.length - MAX_MESSAGES_PER_SUBJECT);
      }
    } else {
      state.messages.set(msg.subject, [tagged]);
    }
    // Only trigger re-render via counter bump
    set({ totalMessages: state.totalMessages + 1 });
  },
  setSelectedMessage: (msg) => set({ selectedMessage: msg }),
  clearMessages: () => set({ messages: new Map(), totalMessages: 0 }),

  // UI
  activeTab: 'subjects',
  theme: 'dark',
  publishPanelOpen: true,
  setActiveTab: (tab) => set({ activeTab: tab }),
  toggleTheme: () => {
    const newTheme = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', newTheme === 'dark');
    set({ theme: newTheme });
  },
  setPublishPanelOpen: (open) => set({ publishPanelOpen: open }),

  // Stats
  totalMessages: 0,
  messagesPerSecond: 0,
  totalSubjects: 0,

  // Cluster
  clusterInfo: null,
  setClusterInfo: (info) => set({ clusterInfo: info }),

  // Internal selections
  _selectedStream: null,
  _selectedKvBucket: null,
  _selectedObjStore: null,
}));
