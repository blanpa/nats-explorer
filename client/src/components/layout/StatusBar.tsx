import { useStore, useActiveConnection } from '../../store';
import { formatNumber, cn } from '../../lib/utils';

export default function StatusBar() {
  const wsOnline = useStore(s => s.wsOnline);
  const connectedCount = useStore(s => s.connections.filter(c => c.connected).length);
  const active = useActiveConnection();
  const totalMessages = useStore(s => s.totalMessages);
  const rate = useStore(s => s.messagesPerSecond);
  const totalSubjects = useStore(s => s.totalSubjects);
  const stats = useStore(s => s.subscriptionStats);

  let dropped = 0;
  let received = 0;
  for (const st of stats.values()) {
    dropped += st.dropped;
    received += st.received;
  }

  return (
    <footer className="h-6 shrink-0 flex items-center gap-4 px-3 text-xs text-muted bg-panel border-t border-line select-none">
      <span className="flex items-center gap-1.5">
        <span className={cn('status-dot', wsOnline ? (connectedCount > 0 ? 'bg-ok' : 'bg-faint') : 'bg-danger')} />
        {!wsOnline ? 'Backend offline' : connectedCount === 0 ? 'Disconnected' : `${connectedCount} connection${connectedCount === 1 ? '' : 's'}`}
      </span>
      {active?.connected && (
        <span className="truncate font-mono text-faint hidden md:inline">
          {active.name} · {active.server?.replace(/^nats:\/\//, '')}
          {active.subscriptions && active.subscriptions.join(',') !== '>' && <span> · {active.subscriptions.join(', ')}</span>}
        </span>
      )}
      <span className="flex-1" />
      {connectedCount > 0 && (
        <>
          <span className="font-mono tabular-nums" title="Subjects seen">
            {formatNumber(totalSubjects)} subjects
          </span>
          <span className="font-mono tabular-nums" title="Messages received on the server side since connect">
            {formatNumber(received || totalMessages)} msgs
          </span>
          <span className="font-mono tabular-nums">{rate.toLocaleString()} msg/s</span>
          {dropped > 0 && (
            <span className="font-mono tabular-nums text-warn" title="Messages not forwarded to the UI: at most 10 msg/s per subject, and subjects you are not looking at share a background budget. Counters and the tree still include them.">
              {formatNumber(dropped)} throttled
            </span>
          )}
        </>
      )}
    </footer>
  );
}
