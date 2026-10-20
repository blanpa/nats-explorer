import { Download } from 'lucide-react';
import type { ConnectionEvent, ConnectionLink, ConnectionStatus } from 'shared';
import { api } from '../../lib/api';
import { downloadText } from '../../lib/exportMessages';
import { useAsync } from '../../lib/useAsync';
import { formatDateTime, formatTime, formatUptime } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Badge, type BadgeTone, SectionTitle } from '../ui/misc';

const TONE: Record<ConnectionEvent['kind'], BadgeTone> = {
  connected: 'ok',
  reconnected: 'ok',
  disconnected: 'warn',
  retrying: 'warn',
  reason: 'warn',
  error: 'warn',
  lameduck: 'warn',
  discovered: 'info',
  failed: 'danger',
  closed: 'neutral',
};

const LINK: Record<ConnectionEvent['link'], string> = { api: 'API', live: 'live', system: 'system' };

const PURPOSE: Record<ConnectionLink['name'], string> = {
  api: 'streams, KV, requests, everything the UI asks',
  live: 'the subscriptions of the live feed',
  system: 'cluster-wide monitoring through the system account',
};

/** The live connection waits out a pause after dropping again and again. */
function paused(conn: ConnectionStatus, l: ConnectionLink): boolean {
  return l.name === 'live' && !!conn.livePausedUntil && conn.livePausedUntil > Date.now();
}

/**
 * The NATS connections the explorer holds for one connection right now, as
 * the server counts them: one for the API, one for the subscriptions, one
 * for the system account when it has credentials.
 */
export function ConnectionLinks({ conn }: { conn: ConnectionStatus }) {
  const links = conn.links ?? [];
  if (links.length === 0) return null;
  const open = links.filter(l => l.connected).length;
  return (
    <div className="px-4 pb-4">
      <SectionTitle>NATS connections · {open === links.length ? links.length : `${open} of ${links.length} up`}</SectionTitle>
      <div className="rounded border border-line">
        <table className="w-full text-xs">
          <tbody>
            {links.map(l => (
              <tr key={l.name} className="border-b border-line last:border-0">
                <td className="w-px px-2 py-1 whitespace-nowrap" title={PURPOSE[l.name]}>
                  {LINK[l.name] ?? l.name}
                </td>
                <td className="w-px px-2 py-1 whitespace-nowrap">
                  <Badge tone={l.connected ? 'ok' : l.reconnecting ? 'warn' : 'danger'}>
                    {l.connected ? 'connected' : paused(conn, l) ? 'paused' : l.reconnecting ? 'reconnecting' : 'disconnected'}
                  </Badge>
                </td>
                <td className="px-2 py-1 font-mono text-muted">
                  {l.server}
                  {l.cid ? <span className="text-faint"> · cid {l.cid}</span> : null}
                </td>
                <td className="w-px px-2 py-1 font-mono tabular-nums text-muted whitespace-nowrap" title={l.since ? formatDateTime(l.since) : undefined}>
                  {l.since ? `up ${formatUptime(Date.now() - l.since)}` : ''}
                </td>
                <td className="w-px px-2 py-1 tabular-nums text-faint whitespace-nowrap">
                  {l.reconnects} reconnect{l.reconnects === 1 ? '' : 's'}
                </td>
                <td className="px-2 py-1 text-faint hidden lg:table-cell">{PURPOSE[l.name]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One event as the server writes it to its own output, for the export. */
export function eventLine(e: ConnectionEvent): string {
  let line = `${new Date(e.at).toISOString()} [${e.link}] ${e.kind}`;
  if (e.server) line += ` ${e.server}`;
  if (e.cid) line += ` cid ${e.cid}`;
  if (e.detail) line += `: ${e.detail}`;
  return line;
}

/**
 * A detail is what was said, then the figures around it, joined by " · "
 * as in the server's output: the first part reads first.
 */
function Detail({ text }: { text: string }) {
  const [head, ...rest] = text.split(' · ');
  return (
    <div>
      <span className="text-fg">{head}</span>
      {rest.length > 0 && <span className="text-muted"> · {rest.join(' · ')}</span>}
    </div>
  );
}

/**
 * What happened to a connection's NATS connections -- the API's, the
 * subscriptions' and the system account's: connects, drops, the server's
 * reason for a drop, reconnects, asynchronous errors. It is what a user
 * sends along with "it keeps disconnecting", hence the export.
 */
export default function ConnectionLog({ conn }: { conn: ConnectionStatus }) {
  // Any change of state brings a new line; between them a slow poll picks
  // up what does not change the status, such as an asynchronous error.
  const { data } = useAsync<ConnectionEvent[]>(
    () => api.connectionLog(conn.id),
    [conn.id, conn.connected, conn.reconnecting, conn.reconnects, conn.liveReconnecting, conn.liveReconnects, conn.lastDrop?.reason],
    { key: `connlog:${conn.id}`, interval: 10_000 },
  );
  const events = data ?? [];

  const exportLog = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = conn.name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'connection';
    downloadText(`${events.map(eventLine).join('\n')}\n`, `${safe}-connection-${stamp}.log`, 'text/plain');
  };

  return (
    <div className="px-4 pb-4">
      <SectionTitle
        actions={
          events.length > 0 && (
            <IconButton label="Download the log" size="xs" onClick={exportLog}>
              <Download size={13} />
            </IconButton>
          )
        }
      >
        Connection log · {events.length}
      </SectionTitle>
      {events.length === 0 ? (
        <div className="text-xs text-muted">Nothing happened yet.</div>
      ) : (
        // Newest first: the question is nearly always "what just happened".
        <div className="max-h-[28rem] overflow-auto rounded border border-line">
          <table className="w-full text-xs">
            <tbody>
              {events
                .slice()
                .reverse()
                .map((e, i) => (
                  <tr key={`${e.at}-${i}`} className="border-b border-line last:border-0 align-top">
                    <td className="w-px px-2 py-1 font-mono tabular-nums text-faint whitespace-nowrap" title={formatDateTime(e.at)}>
                      {formatTime(e.at)}
                    </td>
                    <td className="w-px px-2 py-1 text-muted whitespace-nowrap">{LINK[e.link] ?? e.link}</td>
                    <td className="w-px px-2 py-1 whitespace-nowrap">
                      <Badge tone={TONE[e.kind] ?? 'neutral'}>{e.kind}</Badge>
                    </td>
                    <td className="px-2 py-1 font-mono text-muted break-all">
                      {e.server}
                      {e.cid ? <span className="text-faint"> · cid {e.cid}</span> : null}
                      {e.detail && <Detail text={e.detail} />}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
