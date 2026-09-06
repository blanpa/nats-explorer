import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { useJsDomainOverride, useStore } from '../../store';
import { cn, readSetting, writeSetting } from '../../lib/utils';
import { Input } from '../ui/Input';

const RECENT_KEY = 'ne.jsDomains';

/**
 * Lets the user point the JetStream, KV and Object Store modules at another
 * JetStream domain (e.g. a leaf node behind the hub) without editing the
 * connection. Empty means the connection's own domain.
 */
export default function DomainSwitch() {
  const connId = useStore(s => s.activeConnId);
  const conn = useStore(s => s.connections.find(c => c.id === s.activeConnId));
  const override = useJsDomainOverride(connId);
  const setOverride = useStore(s => s.setJsDomainOverride);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const defaultDomain = conn?.jsDomain || (conn?.jsApiPrefix ? conn.jsApiPrefix : '');
  const recent = readSetting<string[]>(RECENT_KEY, []);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!connId || !conn?.connected) return null;

  const apply = () => {
    const v = value.trim();
    setOverride(connId, v);
    if (v && !recent.includes(v)) writeSetting(RECENT_KEY, [v, ...recent].slice(0, 12));
    setEditing(false);
  };

  if (editing) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={e => {
          e.preventDefault();
          apply();
        }}
      >
        <Input
          ref={inputRef}
          inputSize="sm"
          mono
          list="ne-js-domains"
          className="w-36"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Escape' && setEditing(false)}
          onBlur={() => setEditing(false)}
          placeholder={defaultDomain || 'domain'}
          aria-label="JetStream domain"
        />
        <datalist id="ne-js-domains">
          {defaultDomain && <option value={defaultDomain} />}
          {recent.filter(r => r !== defaultDomain).map(r => <option key={r} value={r} />)}
        </datalist>
      </form>
    );
  }

  const label = override || defaultDomain || 'default';
  return (
    <button
      type="button"
      className={cn('flex items-center gap-1 h-6 px-1.5 rounded text-xs font-mono hover:bg-field', override ? 'text-accent' : 'text-muted')}
      title={`JetStream domain: ${override || defaultDomain || 'connection default'}${override ? ` (connection: ${defaultDomain || 'default'})` : ''}. Click to switch.`}
      onClick={() => {
        setValue(override ?? '');
        setEditing(true);
      }}
    >
      <Globe size={12} />
      <span className="max-w-[120px] truncate">{label}</span>
    </button>
  );
}
