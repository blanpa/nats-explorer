import { useEffect, useState } from 'react';
import { useStore, useActiveConnection } from '../../store';
import { formatBytes, formatNumber, formatUptime, cn } from '../../lib/utils';
import { SourceLink } from '../ui/SourceLink';
import { UpdateHint } from './UpdateHint';

export default function StatusBar() {
  const wsOnline = useStore(s => s.wsOnline);
  const connectedCount = useStore(s => s.connections.filter(c => c.connected).length);
  const active = useActiveConnection();
  const totalSubjects = useStore(s => s.totalSubjects);
  const stats = useStore(s => s.subscriptionStats);
  const setSettingsOpen = useStore(s => s.setSettingsOpen);

  // The uptime has to move on its own: on a quiet connection nothing else
  // would re-render the bar, and a duration that stands still is worse than
  // none. Five seconds is fine for a figure that counts in minutes; the
  // countdown of a paused live feed goes by the second.
  const [, tick] = useState(0);
  const pausing = !!active?.livePausedUntil && active.livePausedUntil > Date.now();
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), pausing ? 1000 : 5000);
    return () => clearInterval(t);
  }, [pausing]);

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
          {active.connectedAt && (
            <span
              title={`Connected since ${new Date(active.connectedAt).toLocaleString()}${active.links?.length ? `, over ${active.links.length} NATS connection${active.links.length === 1 ? '' : 's'} (${active.links.map(l => l.name).join(', ')})` : ''}${active.reconnects ? `, ${active.reconnects} reconnect${active.reconnects === 1 ? '' : 's'}` : ''}${active.liveReconnects ? `; the subscriptions' connection reconnected ${active.liveReconnects}×` : ''}${active.liveError ? `; the subscriptions share this connection, the server refused a second one: ${active.liveError}` : ''}${active.lastDrop ? `; last lost ${new Date(active.lastDrop.at).toLocaleString()}${active.lastDrop.live ? ' (subscriptions)' : ''}: ${active.lastDrop.reason}` : ''}`}
            >
              {' '}
              · up {formatUptime(Date.now() - active.connectedAt)}
            </span>
          )}
          {active.subscriptions && active.subscriptions.join(',') !== '>' && <span> · {active.subscriptions.join(', ')}</span>}
        </span>
      )}
      <span className="flex-1" />
      {/* The server closing the connection for reading too slowly looks like
          a flaky network from here; it is the subscriptions, and it repeats
          until they change. */}
      {/* Only the feed is gone meanwhile: streams, KV and requests run on the
          other connection. */}
      {active?.livePausedUntil && active.livePausedUntil > Date.now() ? (
        // A pause, not a failure: coming straight back would only fill the
        // server's buffer for the explorer again.
        <span
          className="text-warn whitespace-nowrap shrink-0"
          title={`The connection the subscriptions run on dropped ${active.liveFlaps ?? 1}× in a row within a minute of connecting. It waits before it tries again, so the server does not hold a full buffer for the explorer each time. Streams, KV and requests are unaffected.`}
        >
          live feed resumes in {Math.max(1, Math.ceil((active.livePausedUntil - Date.now()) / 1000))} s
        </span>
      ) : (
        active?.liveReconnecting && (
          <span
            className="text-warn whitespace-nowrap shrink-0"
            title="The connection the subscriptions run on was lost and is being reconnected. Streams, KV and requests are unaffected."
          >
            live feed reconnecting…
          </span>
        )
      )}
      {active?.slowConsumerDrops ? (
        <span
          className="font-mono tabular-nums text-warn whitespace-nowrap shrink-0"
          title={`The NATS server closed the connection of the subscriptions ${active.slowConsumerDrops}× as a slow consumer${active.lastDrop?.slowConsumer ? `, last at ${new Date(active.lastDrop.at).toLocaleString()} (${active.lastDrop.reason})` : ''}: the subscriptions match more data than reaches the explorer in time, over this network or on this host. Messages are lost until it is reconnected; streams, KV and requests run on a connection of their own and stay up. Narrower subscription patterns (instead of >), or an explorer closer to the server, keep it up.`}
        >
          {active.slowConsumerDrops}× slow consumer
        </span>
      ) : null}
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
              title="Messages of the selected subject that did not fit the live feed (at most 50 msg/s per subject, and 2000 msg/s or 2 MB/s per tab). They are counted and kept in the history."
            >
              {formatNumber(throttled)} throttled
            </span>
          )}
        </span>
      )}
      <UpdateHint />
      <SourceLink className="shrink-0" />
    </footer>
  );
}
