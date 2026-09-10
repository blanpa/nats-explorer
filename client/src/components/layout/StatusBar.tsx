import { useStore, useActiveConnection } from '../../store';
import { formatBytes, formatNumber, cn } from '../../lib/utils';
import { SourceLink } from '../ui/SourceLink';

export default function StatusBar() {
  const wsOnline = useStore(s => s.wsOnline);
  const connectedCount = useStore(s => s.connections.filter(c => c.connected).length);
  const active = useActiveConnection();
  const totalSubjects = useStore(s => s.totalSubjects);
  const stats = useStore(s => s.subscriptionStats);
  const setSettingsOpen = useStore(s => s.setSettingsOpen);

  let throttled = 0;
  let received = 0;
  let rate = 0;
  let historyBytes = 0;
  let db: { bytes: number; messages: number; dropped: number; retention: string } | null = null;
  // A drop is worth saying out loud, not only colouring: the figure beside
  // it is a size, and a size going yellow does not say what happened.
  for (const st of stats.values()) {
    throttled += st.throttled;
    received += st.received;
    rate += st.rate;
    historyBytes += st.history?.bytes ?? 0;
    if (st.history?.db) db = st.history.db;
  }

  return (
    <footer className="h-6 shrink-0 flex items-center gap-4 px-3 text-xs text-muted bg-panel border-t border-line select-none">
      <span className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
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
        <span className="flex items-center gap-4 shrink-0 whitespace-nowrap">
          <span className="font-mono tabular-nums" title="Subjects seen">
            {formatNumber(totalSubjects)} subjects
          </span>
          <span className="font-mono tabular-nums" title="Messages received on the server side since connect">
            {formatNumber(received)} msgs
          </span>
          <span className="font-mono tabular-nums" title="Messages per second received on the server side">
            {formatNumber(Math.round(rate))} msg/s
          </span>
          {/* Both figures open the setting behind them: how much history is
              kept, and whether it survives a restart. */}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="font-mono tabular-nums text-faint hover:text-fg hidden lg:inline"
            title={`Recent messages kept on the server; the selected subject is loaded from here.${db ? '' : ' Not kept across restarts -- click to change.'}`}
          >
            {formatBytes(historyBytes)} history
          </button>
          {db && (
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className={cn('font-mono tabular-nums hidden lg:inline hover:text-fg', db.dropped > 0 ? 'text-warn' : 'text-faint')}
              title={
                db.dropped > 0
                  ? `${formatNumber(db.dropped)} messages did not reach the disk: they arrived faster than SQLite could write them. The live view is unaffected. Click to see what to change.`
                  : `SQLite copy of the history, retention ${db.retention}`
              }
            >
              {db.dropped > 0 ? `${formatNumber(db.dropped)} not persisted` : `${formatBytes(db.bytes)} on disk`}
            </button>
          )}
          {throttled > 0 && (
            <span
              className="font-mono tabular-nums text-warn"
              title="Messages of the selected subject that did not fit the live feed (at most 50 msg/s per subject and 2000 msg/s per tab). They are counted and kept in the history."
            >
              {formatNumber(throttled)} throttled
            </span>
          )}
        </span>
      )}
      <SourceLink className="shrink-0" />
    </footer>
  );
}
