import { useState } from 'react';
import { api } from '../../lib/api';
import { X, Loader2, Plus, Trash2 } from 'lucide-react';

type AuthMethod = 'none' | 'token' | 'userpass' | 'nkey' | 'jwt';

interface SubEntry {
  subject: string;
}

const DEFAULT_SUBS: SubEntry[] = [
  { subject: '>' },
];

export default function ConnectionDialog({ onClose }: { onClose: () => void }) {
  const [servers, setServers] = useState('nats://localhost:4222');
  const [name, setName] = useState('Local');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('none');
  const [token, setToken] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [nkeySeed, setNkeySeed] = useState('');
  const [creds, setCreds] = useState('');
  const [tls, setTls] = useState(false);
  const [subscriptions, setSubscriptions] = useState<SubEntry[]>([...DEFAULT_SUBS]);
  const [showSubscriptions, setShowSubscriptions] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addSubscription = () => {
    setSubscriptions([...subscriptions, { subject: '' }]);
  };

  const removeSubscription = (index: number) => {
    setSubscriptions(subscriptions.filter((_, i) => i !== index));
  };

  const updateSubscription = (index: number, subject: string) => {
    const updated = [...subscriptions];
    updated[index] = { subject };
    setSubscriptions(updated);
  };

  const handleConnect = async () => {
    setLoading(true);
    setError('');
    try {
      const subs = subscriptions
        .map(s => s.subject.trim())
        .filter(s => s.length > 0);

      await api.connect({
        name,
        servers: servers.split(',').map(s => s.trim()),
        authMethod,
        token: authMethod === 'token' ? token : undefined,
        user: authMethod === 'userpass' ? user : undefined,
        pass: authMethod === 'userpass' ? pass : undefined,
        nkeySeed: authMethod === 'nkey' ? nkeySeed : undefined,
        creds: authMethod === 'jwt' ? creds : undefined,
        tls,
        subscriptions: subs.length > 0 ? subs : undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg w-full max-w-lg p-6 shadow-lg" onClick={e => e.stopPropagation()} style={{ maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Connect to NATS</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium mb-1">Connection Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className={inputClass} />
          </div>

          {/* Server */}
          <div>
            <label className="block text-sm font-medium mb-1">Server URL(s)</label>
            <input value={servers} onChange={e => setServers(e.target.value)} placeholder="nats://localhost:4222" className={inputClass} />
            <p className="text-xs text-muted-foreground mt-1">Comma-separated for clusters</p>
          </div>

          {/* Auth */}
          <div>
            <label className="block text-sm font-medium mb-1">Authentication</label>
            <select value={authMethod} onChange={e => setAuthMethod(e.target.value as AuthMethod)} className={inputClass}>
              <option value="none">None</option>
              <option value="token">Token</option>
              <option value="userpass">User / Password</option>
              <option value="nkey">NKey</option>
              <option value="jwt">JWT / Credentials</option>
            </select>
          </div>

          {authMethod === 'token' && (
            <div>
              <label className="block text-sm font-medium mb-1">Token</label>
              <input type="password" value={token} onChange={e => setToken(e.target.value)} className={inputClass} />
            </div>
          )}
          {authMethod === 'userpass' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Username</label>
                <input value={user} onChange={e => setUser(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Password</label>
                <input type="password" value={pass} onChange={e => setPass(e.target.value)} className={inputClass} />
              </div>
            </div>
          )}
          {authMethod === 'nkey' && (
            <div>
              <label className="block text-sm font-medium mb-1">NKey Seed</label>
              <input type="password" value={nkeySeed} onChange={e => setNkeySeed(e.target.value)} className={inputClass} placeholder="SUAB..." />
            </div>
          )}
          {authMethod === 'jwt' && (
            <div>
              <label className="block text-sm font-medium mb-1">Credentials File Content</label>
              <textarea value={creds} onChange={e => setCreds(e.target.value)} rows={3} className={inputClass + ' font-mono'} placeholder="Paste credentials..." />
            </div>
          )}

          {/* TLS */}
          <div className="flex items-center gap-2">
            <input type="checkbox" id="tls" checked={tls} onChange={e => setTls(e.target.checked)} className="rounded" />
            <label htmlFor="tls" className="text-sm">Use TLS</label>
          </div>

          {/* Subscriptions - MQTT Explorer style */}
          <div className="conn-subs-section">
            <button
              onClick={() => setShowSubscriptions(!showSubscriptions)}
              className="conn-subs-toggle"
            >
              <span>{showSubscriptions ? '▾' : '▸'}</span>
              <span>Subscriptions</span>
              <span className="conn-subs-count">{subscriptions.length}</span>
            </button>

            {showSubscriptions && (
              <div className="conn-subs-list">
                <p className="conn-subs-hint">
                  Configure which subjects to subscribe to. Use <code>&gt;</code> for all, or specific patterns like <code>uns.&gt;</code>, <code>events.&gt;</code>
                </p>

                {subscriptions.map((sub, i) => (
                  <div key={i} className="conn-sub-row">
                    <input
                      value={sub.subject}
                      onChange={e => updateSubscription(i, e.target.value)}
                      placeholder="e.g. uns.> or events.alarm.>"
                      className="conn-sub-input"
                    />
                    <button
                      onClick={() => removeSubscription(i)}
                      className="conn-sub-remove"
                      disabled={subscriptions.length <= 1}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}

                <button onClick={addSubscription} className="conn-sub-add">
                  <Plus size={12} />
                  <span>Add Subscription</span>
                </button>

                {/* Quick presets */}
                <div className="conn-subs-presets">
                  <span className="conn-subs-presets-label">Presets:</span>
                  <button onClick={() => setSubscriptions([{ subject: '>' }])} className="conn-subs-preset">All (&gt;)</button>
                  <button onClick={() => setSubscriptions([{ subject: 'uns.>' }, { subject: 'events.>' }, { subject: 'metrics.>' }])} className="conn-subs-preset">UNS</button>
                  <button onClick={() => setSubscriptions([{ subject: 'uns.>' }])} className="conn-subs-preset">UNS only</button>
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="p-3 bg-destructive/10 text-destructive text-sm rounded-md">{error}</div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-md hover:bg-accent">Cancel</button>
            <button
              onClick={handleConnect}
              disabled={loading}
              className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
