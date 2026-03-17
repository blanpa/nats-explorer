import { useState } from 'react';
import { useStore, ConnectionInfo } from '../../store';
import { api } from '../../lib/api';
import { Plus, Plug, PlugZap, Trash2, Edit3, Loader2, ChevronDown, ChevronRight, Key } from 'lucide-react';
import ConnectionDialog from './ConnectionDialog';

interface SavedConnection {
  name: string;
  host: string;
  port: string;
  authMethod: 'none' | 'token' | 'userpass' | 'nkey' | 'jwt';
  subscriptions: string[];
  token?: string;
  user?: string;
  pass?: string;
  nkeySeed?: string;
  creds?: string;
  tls?: boolean;
  monitoringPort?: number;
  // System topic toggles
  sysTopics?: {
    sys?: boolean;    // $SYS.> - Server monitoring/stats
    js?: boolean;     // $JS.> - JetStream internal events
    kv?: boolean;     // $KV.> - KV change notifications
    srv?: boolean;    // $SRV.> - Service discovery
  };
}

const SYSTEM_TOPICS: { key: keyof NonNullable<SavedConnection['sysTopics']>; subject: string; label: string; description: string }[] = [
  { key: 'sys', subject: '$SYS.>', label: '$SYS', description: 'Server monitoring & stats' },
  { key: 'js',  subject: '$JS.>',  label: '$JS',  description: 'JetStream internal events' },
  { key: 'kv',  subject: '$KV.>',  label: '$KV',  description: 'KV change notifications' },
  { key: 'srv', subject: '$SRV.>', label: '$SRV', description: 'Service discovery & ping' },
];

const DEFAULT_SAVED: SavedConnection[] = [
  { name: 'Local', host: 'localhost', port: '4222', authMethod: 'none', subscriptions: ['>'] },
];

export default function ConnectionPanel() {
  const { connections, activeConnId, setActiveConnId } = useStore();
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>(() => {
    try {
      const stored = localStorage.getItem('nats-explorer-connections');
      return stored ? JSON.parse(stored) : DEFAULT_SAVED;
    } catch { return DEFAULT_SAVED; }
  });
  const [showAdd, setShowAdd] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persist = (conns: SavedConnection[]) => {
    setSavedConnections(conns);
    localStorage.setItem('nats-explorer-connections', JSON.stringify(conns));
  };

  const handleConnect = async (saved: SavedConnection) => {
    const key = `${saved.host}:${saved.port}`;
    setConnecting(key);
    setError(null);
    try {
      // Merge user subscriptions with enabled system topics
      const allSubs = [...(saved.subscriptions.length > 0 ? saved.subscriptions : ['>'])];
      if (saved.sysTopics) {
        for (const st of SYSTEM_TOPICS) {
          if (saved.sysTopics[st.key]) {
            allSubs.push(st.subject);
          }
        }
      }

      await api.connect({
        name: saved.name,
        servers: [`nats://${saved.host}:${saved.port}`],
        authMethod: saved.authMethod || 'none',
        token: saved.authMethod === 'token' ? saved.token : undefined,
        user: saved.authMethod === 'userpass' ? saved.user : undefined,
        pass: saved.authMethod === 'userpass' ? saved.pass : undefined,
        nkeySeed: saved.authMethod === 'nkey' ? saved.nkeySeed : undefined,
        creds: saved.authMethod === 'jwt' ? saved.creds : undefined,
        tls: saved.tls,
        monitoringPort: saved.monitoringPort,
        subscriptions: allSubs,
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (connId: string) => {
    try { await api.disconnect(connId); } catch {}
  };

  const findActiveConn = (saved: SavedConnection): ConnectionInfo | undefined => {
    return connections.find(c => c.connected && c.name === saved.name);
  };

  const deleteSaved = (index: number) => {
    persist(savedConnections.filter((_, i) => i !== index));
  };

  return (
    <div className="connpanel">
      <div className="connpanel-header">
        <span className="connpanel-title">Connections</span>
        <button onClick={() => setShowAdvanced(true)} className="connpanel-btn" title="Advanced connection">
          <Plus size={12} />
        </button>
      </div>

      {error && (
        <div className="connpanel-error">
          {error}
          <button onClick={() => setError(null)} className="connpanel-error-close">&times;</button>
        </div>
      )}

      <div className="connpanel-list">
        {savedConnections.map((saved, i) => {
          const activeConn = findActiveConn(saved);
          const isActive = activeConn && activeConnId === activeConn.id;
          const isConnected = !!activeConn;
          const isConnecting = connecting === `${saved.host}:${saved.port}`;

          return (
            <div
              key={i}
              className={`connpanel-item ${isActive ? 'connpanel-item-active' : ''}`}
              onClick={() => { if (activeConn) setActiveConnId(activeConn.id); }}
            >
              {editIndex === i ? (
                <ConnectionInlineEdit
                  saved={saved}
                  onSave={(updated) => {
                    const newList = [...savedConnections];
                    newList[i] = updated;
                    persist(newList);
                    setEditIndex(null);
                  }}
                  onCancel={() => setEditIndex(null)}
                />
              ) : (
                <>
                  <div className="connpanel-item-header">
                    <span className={`connpanel-status-dot ${isConnected ? 'connpanel-dot-on' : 'connpanel-dot-off'}`} />
                    <span className="connpanel-item-name">{saved.name}</span>
                    {saved.authMethod !== 'none' && (
                      <span className="connpanel-auth-icon" title={`Auth: ${saved.authMethod}`}><Key size={9} /></span>
                    )}
                    <div className="connpanel-item-actions">
                      <button onClick={(e) => { e.stopPropagation(); setEditIndex(i); }} className="connpanel-item-btn" title="Edit">
                        <Edit3 size={10} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); deleteSaved(i); }} className="connpanel-item-btn connpanel-item-btn-del" title="Delete">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                  <div className="connpanel-item-server">
                    {saved.host}:{saved.port}
                    {saved.tls && <span className="connpanel-tls-badge">TLS</span>}
                  </div>
                  {saved.subscriptions.length > 0 && saved.subscriptions[0] !== '>' && (
                    <div className="connpanel-item-subs">
                      {saved.subscriptions.map((s, j) => (
                        <span key={j} className="connpanel-sub-tag">{s}</span>
                      ))}
                    </div>
                  )}
                  {saved.sysTopics && Object.entries(saved.sysTopics).some(([, v]) => v) && (
                    <div className="connpanel-item-subs">
                      {SYSTEM_TOPICS.filter(st => saved.sysTopics?.[st.key]).map(st => (
                        <span key={st.key} className="connpanel-sys-tag">{st.label}</span>
                      ))}
                    </div>
                  )}
                  <div className="connpanel-item-footer">
                    {isConnected ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDisconnect(activeConn!.id); }}
                        className="connpanel-connect-btn connpanel-disconnect-btn"
                      >
                        <PlugZap size={11} />
                        <span>Disconnect</span>
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleConnect(saved); }}
                        disabled={isConnecting}
                        className="connpanel-connect-btn"
                      >
                        {isConnecting ? <Loader2 size={11} className="animate-spin" /> : <Plug size={11} />}
                        <span>{isConnecting ? 'Connecting...' : 'Connect'}</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}

        {showAdd ? (
          <ConnectionInlineEdit
            saved={{ name: '', host: 'localhost', port: '4222', authMethod: 'none', subscriptions: ['>'] }}
            onSave={(saved) => {
              persist([...savedConnections, saved]);
              setShowAdd(false);
            }}
            onCancel={() => setShowAdd(false)}
            isNew
          />
        ) : (
          <button onClick={() => setShowAdd(true)} className="connpanel-add-btn">
            <Plus size={12} />
            <span>Add Connection</span>
          </button>
        )}
      </div>

      {showAdvanced && <ConnectionDialog onClose={() => {
        setShowAdvanced(false);
        try {
          const stored = localStorage.getItem('nats-explorer-connections');
          if (stored) setSavedConnections(JSON.parse(stored));
        } catch {}
      }} />}
    </div>
  );
}

function ConnectionInlineEdit({
  saved,
  onSave,
  onCancel,
  isNew,
}: {
  saved: SavedConnection;
  onSave: (s: SavedConnection) => void;
  onCancel: () => void;
  isNew?: boolean;
}) {
  const [name, setName] = useState(saved.name);
  const [host, setHost] = useState(saved.host);
  const [port, setPort] = useState(saved.port);
  const [subs, setSubs] = useState(saved.subscriptions.join(', '));
  const [authMethod, setAuthMethod] = useState(saved.authMethod);
  const [token, setToken] = useState(saved.token || '');
  const [user, setUser] = useState(saved.user || '');
  const [pass, setPass] = useState(saved.pass || '');
  const [nkeySeed, setNkeySeed] = useState(saved.nkeySeed || '');
  const [creds, setCreds] = useState(saved.creds || '');
  const [tls, setTls] = useState(saved.tls || false);
  const [monitoringPort, setMonitoringPort] = useState<number | undefined>(saved.monitoringPort);
  const [sysTopics, setSysTopics] = useState(saved.sysTopics || {});
  const [showAuth, setShowAuth] = useState(saved.authMethod !== 'none');
  const [showSysTopics, setShowSysTopics] = useState(Object.values(saved.sysTopics || {}).some(v => v));

  const handleSave = () => {
    const subscriptions = subs.split(',').map(s => s.trim()).filter(s => s.length > 0);
    onSave({
      name: name || `${host}:${port}`,
      host, port, authMethod,
      subscriptions: subscriptions.length > 0 ? subscriptions : ['>'],
      token: authMethod === 'token' ? token : undefined,
      user: authMethod === 'userpass' ? user : undefined,
      pass: authMethod === 'userpass' ? pass : undefined,
      nkeySeed: authMethod === 'nkey' ? nkeySeed : undefined,
      creds: authMethod === 'jwt' ? creds : undefined,
      tls,
      monitoringPort,
      sysTopics,
    });
  };

  const inp = "connpanel-edit-input";

  return (
    <div className="connpanel-edit">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Connection Name" className={inp} />
      <div className="connpanel-edit-row">
        <input value={host} onChange={e => setHost(e.target.value)} placeholder="Host" className={inp} style={{ flex: 2 }} />
        <input value={port} onChange={e => setPort(e.target.value)} placeholder="Port" className={inp} style={{ flex: 1 }} />
      </div>
      <input value={subs} onChange={e => setSubs(e.target.value)} placeholder="Subscriptions: > (all)" className={inp} />

      {/* Auth toggle */}
      <button onClick={() => setShowAuth(!showAuth)} className="connpanel-edit-section-toggle">
        {showAuth ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>Authentication</span>
        {authMethod !== 'none' && <span className="connpanel-edit-auth-badge">{authMethod}</span>}
      </button>

      {showAuth && (
        <div className="connpanel-edit-auth">
          <select value={authMethod} onChange={e => setAuthMethod(e.target.value as any)} className={inp}>
            <option value="none">None</option>
            <option value="token">Token</option>
            <option value="userpass">User / Password</option>
            <option value="nkey">NKey</option>
            <option value="jwt">JWT / Credentials</option>
          </select>

          {authMethod === 'token' && (
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Token" className={inp} />
          )}

          {authMethod === 'userpass' && (
            <>
              <input value={user} onChange={e => setUser(e.target.value)} placeholder="Username" className={inp} />
              <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="Password" className={inp} />
            </>
          )}

          {authMethod === 'nkey' && (
            <input type="password" value={nkeySeed} onChange={e => setNkeySeed(e.target.value)} placeholder="NKey Seed (SUAB...)" className={inp} />
          )}

          {authMethod === 'jwt' && (
            <textarea value={creds} onChange={e => setCreds(e.target.value)} placeholder="Paste credentials content..." className={inp} rows={3} style={{ resize: 'vertical', fontFamily: 'var(--font-mono)' }} />
          )}

          <label className="connpanel-edit-checkbox">
            <input type="checkbox" checked={tls} onChange={e => setTls(e.target.checked)} />
            <span>TLS</span>
          </label>
          <div className="connpanel-edit-row">
            <label className="connpanel-edit-checkbox" style={{ flex: 'none' }}>Monitoring Port</label>
            <input
              type="number"
              value={monitoringPort || ''}
              onChange={e => setMonitoringPort(e.target.value ? parseInt(e.target.value) : undefined)}
              placeholder="8222"
              className={inp}
              style={{ width: 70 }}
            />
          </div>
        </div>
      )}

      {/* System Topics toggle */}
      <button onClick={() => setShowSysTopics(!showSysTopics)} className="connpanel-edit-section-toggle">
        {showSysTopics ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>System Topics</span>
        {Object.values(sysTopics).filter(Boolean).length > 0 && (
          <span className="connpanel-edit-sys-count">{Object.values(sysTopics).filter(Boolean).length}</span>
        )}
      </button>

      {showSysTopics && (
        <div className="connpanel-edit-systopics">
          {SYSTEM_TOPICS.map(st => (
            <label key={st.key} className="connpanel-systopic-row">
              <input
                type="checkbox"
                checked={!!sysTopics[st.key]}
                onChange={e => setSysTopics({ ...sysTopics, [st.key]: e.target.checked })}
              />
              <span className="connpanel-systopic-label">{st.label}</span>
              <span className="connpanel-systopic-desc">{st.description}</span>
            </label>
          ))}
        </div>
      )}

      <div className="connpanel-edit-actions">
        <button onClick={handleSave} className="connpanel-edit-save">{isNew ? 'Add' : 'Save'}</button>
        <button onClick={onCancel} className="connpanel-edit-cancel">Cancel</button>
      </div>
    </div>
  );
}
