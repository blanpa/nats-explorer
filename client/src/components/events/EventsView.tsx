import { useMemo, useState } from 'react';
import { AlertTriangle, Bell, CircleAlert, Info, RefreshCw } from 'lucide-react';
import type { NatsMessage } from 'shared';
import { api } from '../../lib/api';
import { countBySeverity, type EventSeverity, eventsOf, type ServerEvent } from '../../lib/advisories';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import { cn, formatTime } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge, EmptyState, PaneHeader, Segmented } from '../ui/misc';
import PayloadViewer from '../subjects/PayloadViewer';
import { toast } from '../ui/Toast';
import { errorMessage } from '../../lib/api';
import { useCanWrite } from '../../lib/auth';

const REFRESH_MS = 5000;
const LIMIT = 300;

/** The two roots the servers publish events under. */
const ROOTS = ['$JS.EVENT', '$SYS'];

const ICON: Record<EventSeverity, typeof Info> = { error: CircleAlert, warn: AlertTriangle, info: Info };
const TONE: Record<EventSeverity, string> = { error: 'text-danger', warn: 'text-warn', info: 'text-muted' };

/**
 * What the server said happened.
 *
 * JetStream publishes an advisory for everything that matters -- a consumer
 * that gave up, a message terminated, a stream that lost quorum, a refused
 * API call -- and the system account does the same for clients and servers.
 * They are ordinary messages on `$JS.EVENT.>` and `$SYS.>`, so the explorer
 * already records them; this reads them as a log rather than as JSON in a
 * subject tree. "My message never arrived" is answered here, not by a gauge.
 */
export default function EventsView() {
  const connId = useStore(s => s.activeConnId);
  const connections = useStore(s => s.connections);
  const canWrite = useCanWrite();
  const [severity, setSeverity] = useState<'all' | 'problems'>('all');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<NatsMessage | null>(null);
  const [subscribing, setSubscribing] = useState(false);

  const conn = connections.find(c => c.id === connId) ?? connections.find(c => c.connected);
  const watching = ROOTS.filter(root => conn?.subscriptions?.some(p => coversRoot(p, root)));

  const { data, reload, loading } = useAsync(
    async () => {
      if (!conn?.id || watching.length === 0) return [] as NatsMessage[];
      const answers = await Promise.all(watching.map(root => api.getHistory(root, { connId: conn.id, limit: 1, branchLimit: LIMIT }).catch(() => null)));
      return answers.flatMap(a => a?.branch ?? []);
    },
    [conn?.id, watching.join(',')],
    { interval: REFRESH_MS, key: conn?.id ? `events:${conn.id}:${watching.join(',')}` : undefined },
  );

  const events = useMemo(() => eventsOf(data ?? []), [data]);
  const counts = countBySeverity(events);
  const shown = events.filter(e => {
    if (severity === 'problems' && e.severity === 'info') return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return e.title.toLowerCase().includes(q) || e.subject.toLowerCase().includes(q) || e.kind.toLowerCase().includes(q);
  });

  /** Turns the subscription on, which is the only reason the list is empty. */
  const watch = async (root: string) => {
    if (!conn) return;
    setSubscribing(true);
    try {
      const pattern = `${root}.>`;
      await api.setSubscriptions(conn.id, [...(conn.subscriptions ?? []), pattern]);
      const saved = useSavedConnections.getState().items.find(i => i.id === conn.id);
      if (saved) {
        const key = root === '$SYS' ? 'sys' : 'js';
        useSavedConnections.getState().upsert({ ...saved, sysTopics: { ...saved.sysTopics, [key]: true } });
      }
      toast.success(`Watching ${pattern}`);
      reload();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubscribing(false);
    }
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <PaneHeader title="Events">
        <span className="text-xs text-faint truncate">What the servers reported: JetStream advisories and system events</span>
        <div className="ml-auto flex items-center gap-2">
          <Segmented
            size="xs"
            value={severity}
            onChange={setSeverity}
            options={[
              { id: 'all', label: 'All' },
              { id: 'problems', label: 'Problems' },
            ]}
          />
          <Input
            inputSize="sm"
            className="w-52"
            placeholder="Filter events…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Filter events"
          />
          <IconButton label="Reload" size="sm" onClick={reload}>
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
          </IconButton>
        </div>
      </PaneHeader>

      <div className="flex items-center gap-3 px-3 py-1.5 text-xs border-b border-line">
        <span className="text-danger">
          {counts.error} {counts.error === 1 ? 'error' : 'errors'}
        </span>
        <span className="text-warn">
          {counts.warn} {counts.warn === 1 ? 'warning' : 'warnings'}
        </span>
        <span className="text-muted">{counts.info} other</span>
        <span className="ml-auto text-faint font-mono">{watching.length ? `watching ${watching.map(r => `${r}.>`).join(', ')}` : 'nothing watched'}</span>
      </div>

      {watching.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No events are being watched"
          description="Advisories are ordinary messages. Subscribe to $JS.> for JetStream advisories, or to $SYS.> for client and server events — the latter needs a connection with a system account."
          action={
            canWrite && conn ? (
              <div className="flex items-center gap-2">
                <Button variant="primary" size="md" loading={subscribing} onClick={() => watch('$JS')}>
                  Watch $JS.&gt;
                </Button>
                <Button variant="outline" size="md" loading={subscribing} onClick={() => watch('$SYS')}>
                  Watch $SYS.&gt;
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={events.length ? 'Nothing matches' : 'Nothing has happened yet'}
          description={
            events.length
              ? 'Every recorded event is filtered out by the search or by "Problems".'
              : 'The subscription is on, and the servers have reported nothing since it started. Advisories are published as they happen; the ones from before are not kept by NATS.'
          }
        />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-24">Time</th>
                  <th className="w-32">Kind</th>
                  <th>What happened</th>
                  <th className="w-64">Subject</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(e => (
                  <EventRow key={`${e.subject}-${e.at}-${e.title}`} event={e} active={picked === e.message} onPick={() => setPicked(e.message)} />
                ))}
              </tbody>
            </table>
          </div>
          {picked && (
            <div className="w-[420px] shrink-0 border-l border-line p-3 overflow-auto">
              <PayloadViewer payload={picked.payload} type={picked.payloadType} subject={picked.subject} size={picked.size} maxHeight={600} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, active, onPick }: { event: ServerEvent; active: boolean; onPick: () => void }) {
  const Icon = ICON[event.severity];
  const reveal = useStore(s => s.revealSubject);
  return (
    <tr className={cn('cursor-pointer', active && 'bg-accent/10')} onClick={onPick}>
      <td className="font-mono text-muted whitespace-nowrap">{formatTime(event.at)}</td>
      <td>
        <Badge tone={event.severity === 'error' ? 'danger' : event.severity === 'warn' ? 'warn' : 'neutral'}>
          <Icon size={10} className={TONE[event.severity]} /> {event.kind}
        </Badge>
      </td>
      <td className="min-w-0">
        <span className="truncate block" title={event.title}>
          {event.title}
        </span>
      </td>
      <td className="font-mono text-faint max-w-[260px]">
        <button
          type="button"
          className="truncate block max-w-full hover:text-fg text-left"
          title={`Open ${event.subject}`}
          onClick={ev => {
            ev.stopPropagation();
            reveal(event.subject);
          }}
        >
          {event.subject}
        </button>
      </td>
    </tr>
  );
}

/** Whether a subscription pattern covers everything under a root. */
function coversRoot(pattern: string, root: string): boolean {
  if (pattern === '>' || pattern === `${root}.>`) return true;
  // `$JS.EVENT.>` covers `$JS.EVENT`, and `$JS.>` covers it as well.
  const p = pattern.replace(/\.>$/, '');
  return root.startsWith(`${p}.`) || p === root;
}
