import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import type { ConnectionStatus } from 'shared';
import { useStore } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import { api, errorMessage } from '../../lib/api';
import { loadHistory } from '../../lib/feed';
import { SYSTEM_TOPICS, type SystemTopicKey } from '../../lib/savedConnections';
import { cn, formatCount, formatNumber, readSetting, writeSetting } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Input } from '../ui/Input';
import { toast } from '../ui/Toast';
import { useCanWrite } from '../../lib/auth';

const OPEN_KEY = 'ne.subscriptionsOpen';

/** Splits a connection's patterns into the user's own and the system toggles. */
function splitPatterns(subs: string[]): { own: string[]; sys: Set<SystemTopicKey> } {
  const own: string[] = [];
  const sys = new Set<SystemTopicKey>();
  for (const s of subs) {
    const st = SYSTEM_TOPICS.find(t => t.subject === s);
    if (st) sys.add(st.key);
    else own.push(s);
  }
  return { own, sys };
}

/** Patterns separated by commas, spaces or newlines; subjects never contain whitespace. */
function parsePatterns(text: string): string[] {
  const out: string[] = [];
  for (const p of text.split(/[\s,]+/)) if (p && !out.includes(p)) out.push(p);
  return out;
}

/** Switches a live connection to new patterns and remembers them in the saved connection. */
async function applyPatterns(conn: ConnectionStatus, own: string[], sys: Set<SystemTopicKey>): Promise<void> {
  // An empty list stays empty. Putting ">" back would make the one pattern
  // nobody can afford on a busy cluster the only one that cannot be removed.
  const subs = [...own, ...SYSTEM_TOPICS.filter(t => sys.has(t.key)).map(t => t.subject)];
  await api.setSubscriptions(conn.id, subs);
  const saved = useSavedConnections.getState().items.find(i => i.id === conn.id);
  if (saved) {
    const sysTopics: Partial<Record<SystemTopicKey, boolean>> = {};
    for (const t of SYSTEM_TOPICS) sysTopics[t.key] = sys.has(t.key);
    useSavedConnections.getState().upsert({ ...saved, subscriptions: own, sysTopics });
  }
  // Subjects that are still covered keep their history; the backend drops
  // only what no pattern matches any more, and the feed picks that up.
  void loadHistory(true);
}

function rateText(rate: number): string {
  if (rate < 0.05) return '';
  return `${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/s`;
}

function ConnectionSubscriptions({ conn, showName }: { conn: ConnectionStatus; showName: boolean }) {
  const canWrite = useCanWrite();
  const stats = useStore(s => s.subscriptionStats.get(conn.id)?.patterns);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const subs = conn.subscriptions ?? [];
  const { own, sys } = splitPatterns(subs);
  const statOf = (pattern: string) => stats?.find(p => p.pattern === pattern);

  const change = async (nextOwn: string[], nextSys: Set<SystemTopicKey>) => {
    setBusy(true);
    try {
      await applyPatterns(conn, nextOwn, nextSys);
    } catch (err) {
      toast.error('Could not change subscriptions', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const added = parsePatterns(text).filter(p => !own.includes(p));
    if (added.length === 0) return;
    setText('');
    // Adding a concrete pattern to a catch-all subscription replaces it: that is what "subscribe to these" means.
    const base = own.length === 1 && own[0] === '>' ? [] : own;
    void change([...base, ...added], sys);
  };

  const remove = (pattern: string) =>
    void change(
      own.filter(p => p !== pattern),
      sys,
    );

  const toggleSys = (key: SystemTopicKey) => {
    const next = new Set(sys);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      // Subscribing to system subjects only makes sense when the tree shows them.
      if (useStore.getState().hideSystemSubjects) useStore.getState().setHideSystemSubjects(false);
    }
    void change(own, next);
  };

  return (
    <div className={cn('flex flex-col', busy && 'opacity-60 pointer-events-none')}>
      {showName && (
        <div className="flex items-center gap-1.5 px-2 pt-1 text-xs text-muted">
          <span className="status-dot shrink-0 w-1.5! h-1.5!" style={{ background: conn.color }} />
          <span className="truncate">{conn.name}</span>
        </div>
      )}
      {/* Listening to nothing is a state worth naming: an empty tree beside
          an empty panel otherwise reads as a broken connection. */}
      {subs.length === 0 && (
        <div className="px-2 py-1.5 text-xs text-muted">
          No subscriptions — this connection receives nothing. Add a pattern below, or <code className="font-mono">&gt;</code> for everything.
        </div>
      )}
      {subs.map(pattern => {
        const st = statOf(pattern);
        const topic = SYSTEM_TOPICS.find(t => t.subject === pattern);
        const quiet = st && st.subjects === 0;
        return (
          <div
            key={pattern}
            className="group flex items-center gap-2 h-6 px-2 text-xs hover:bg-field/60"
            title={st ? `${formatCount(st.received)} messages received through ${pattern}` : pattern}
          >
            <span className={cn('font-mono truncate flex-1 min-w-0', topic ? 'text-muted' : 'text-fg')}>{pattern}</span>
            {st && st.subjects > 0 && (
              <span className="tabular-nums text-muted shrink-0" title="Subjects matching this pattern">
                {formatNumber(st.subjects)} subj
              </span>
            )}
            {quiet && (
              <span
                className="text-faint shrink-0"
                title={topic?.key === 'sys' ? 'System events are only delivered to the system account' : 'Subscribed, nothing received yet'}
              >
                {topic?.key === 'sys' ? 'system account only' : 'nothing yet'}
              </span>
            )}
            {st && rateText(st.rate) && (
              <span className={cn('tabular-nums shrink-0', st.rate >= 10 ? 'text-warn' : 'text-faint')} title="Messages per second through this pattern">
                {rateText(st.rate)}
              </span>
            )}
            <IconButton
              label={`Unsubscribe ${pattern}`}
              size="xs"
              hidden={!canWrite}
              className="shrink-0 opacity-40 group-hover:opacity-100"
              onClick={() => (topic ? toggleSys(topic.key) : remove(pattern))}
            >
              <X size={11} />
            </IconButton>
          </div>
        );
      })}
      <form
        className="flex items-center gap-1 px-2 py-1"
        hidden={!canWrite}
        onSubmit={e => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          mono
          inputSize="sm"
          className="flex-1 min-w-0"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Add pattern, e.g. orders.>"
          title="Subject pattern; several separated by commas or spaces. Enter adds."
          aria-label={`Add subscription to ${conn.name}`}
          spellCheck={false}
        />
        <IconButton label={`Add subscription to ${conn.name}`} size="xs" onClick={add} disabled={!text.trim()}>
          <Plus size={12} />
        </IconButton>
      </form>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5" hidden={!canWrite}>
        <span className="text-[11px] text-faint mr-0.5">System</span>
        {SYSTEM_TOPICS.map(t => (
          <button
            key={t.key}
            type="button"
            className={cn('btn btn-xs font-mono gap-1', sys.has(t.key) ? 'btn-primary' : 'btn-outline')}
            onClick={() => toggleSys(t.key)}
            title={`${sys.has(t.key) ? 'Unsubscribe' : 'Subscribe to'} ${t.subject} · ${t.description}${t.key === 'sys' ? '. Only delivered when the connection uses the system account' : ''}`}
            aria-pressed={sys.has(t.key)}
          >
            {sys.has(t.key) && <Check size={11} />}
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * What each connected server is subscribed to, as an editable list: one
 * row per pattern with the subjects it matches and its rate, a field to add
 * patterns, toggles for the system subjects. Every change applies at once,
 * without reconnecting, and is remembered in the saved connection.
 */
export default function SubscriptionsPanel() {
  const connections = useStore(s => s.connections);
  const stats = useStore(s => s.subscriptionStats);
  const connected = connections.filter(c => c.connected);
  // Open by itself only when something other than the catch-all is subscribed.
  const custom = connected.some(c => (c.subscriptions ?? []).join() !== '>');
  const [open, setOpen] = useState<boolean | null>(() => readSetting<boolean | null>(OPEN_KEY, null));
  const isOpen = open ?? custom;
  if (connected.length === 0) return null;

  const toggle = () => {
    writeSetting(OPEN_KEY, !isOpen);
    setOpen(!isOpen);
  };
  // What is actually subscribed, not a stand-in for it: counting an empty
  // list as one pattern is how "no subscriptions" reads as "1 pattern".
  const summary = connected.flatMap(c => c.subscriptions ?? []).join(', ') || 'nothing subscribed';
  const patternCount = connected.reduce((n, c) => n + (c.subscriptions?.length ?? 0), 0);
  let subjects = 0;
  for (const c of connected) subjects += stats.get(c.id)?.subjects ?? 0;

  return (
    <div className="border-b border-line" role="group" aria-label="Subscriptions">
      {/* Collapsed, the counts say enough; the patterns themselves are one
          click away and sit in the tooltip meanwhile. */}
      <button
        type="button"
        className="w-full flex items-center gap-1.5 h-7 px-2 text-xs text-muted hover:text-fg"
        onClick={toggle}
        aria-expanded={isOpen}
        title={isOpen ? undefined : summary}
      >
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="font-semibold shrink-0">Subscriptions</span>
        <span className="ml-auto tabular-nums text-faint shrink-0">
          {patternCount === 0 ? (
            <span className="text-warn">no subscriptions</span>
          ) : (
            <>
              {patternCount} pattern{patternCount === 1 ? '' : 's'} · {formatNumber(subjects)} subject{subjects === 1 ? '' : 's'}
            </>
          )}
        </span>
      </button>
      {isOpen && connected.map(conn => <ConnectionSubscriptions key={conn.id} conn={conn} showName={connected.length > 1} />)}
    </div>
  );
}
