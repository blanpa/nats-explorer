import { useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { StreamInfo, StreamMessage, StreamMessagesPage } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useLiveWatch } from '../../lib/live';
import { useJsDomainOverride } from '../../store';
import { Button } from '../ui/Button';
import { ColumnGrip, useColumnWidths } from '../ui/columns';
import { confirm } from '../ui/Dialog';
import { EmptyState, ErrorState, LoadingState } from '../ui/misc';
import { toast } from '../ui/Toast';
import { useCanWrite } from '../../lib/auth';
import StreamChart, { type ChartSpec } from './StreamChart';
import StreamMessageRow from './StreamMessageRow';
import { msgId, repeatedIds } from '../../lib/natsHeaders';
import StreamMessagesToolbar from './StreamMessagesToolbar';

/** Widths the table opens with; the reader's own are remembered per browser. */
const DEFAULT_WIDTHS = { seq: 80, time: 112, subject: 300, size: 80 };

export default function StreamMessages({ connId, stream, onChanged }: { connId: string; stream: StreamInfo; onChanged: () => void }) {
  const canWrite = useCanWrite();
  const domainOverride = useJsDomainOverride(connId);
  const [startSeq, setStartSeq] = useState<number | undefined>(undefined); // undefined = newest page
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState<number | null>(null);
  // Seq, time, subject and size are dragged to width; the payload column
  // takes the rest. The two icon columns have nothing to widen.
  const { widths, resize } = useColumnWidths('ne.streamMessageCols', DEFAULT_WIDTHS);
  // Newest first, the way a stream is usually read; ascending follows the
  // sequence, which is the order things happened in.
  const [desc, setDesc] = useState(true);
  const [live, setLive] = useState(false);
  const [liveMsgs, setLiveMsgs] = useState<StreamMessage[]>([]);
  const [chart, setChart] = useState<ChartSpec | null>(null);

  const {
    data: page,
    error,
    loading,
    initial,
    reload,
  } = useAsync<StreamMessagesPage>(() => api.getStreamMessages(connId, stream.name, { startSeq, limit }), [connId, stream.name, startSeq, limit], {
    key: `msgs:${connId}:${stream.name}:${startSeq ?? 'newest'}:${limit}`,
  });

  const onNewestPage = startSeq === undefined;
  useLiveWatch(
    live && onNewestPage ? { type: 'stream-tail', connId, stream: stream.name, domain: domainOverride } : null,
    live && onNewestPage ? { type: 'stream-untail', connId, stream: stream.name } : null,
    'stream-msg',
    e => {
      if (e.connId !== connId || e.stream !== stream.name) return;
      setLiveMsgs(prev => (prev.some(m => m.seq === e.message.seq) ? prev : [e.message, ...prev].slice(0, 200)));
    },
  );
  const toggleLive = () => {
    setLive(v => !v);
    setLiveMsgs([]);
    setStartSeq(undefined);
  };

  const first = page?.firstSeq ?? stream.state.firstSeq;
  const last = page?.lastSeq ?? stream.state.lastSeq;
  const pageStart = page?.pageStart ?? 0;
  const pageEnd = page?.pageEnd ?? 0;

  const del = async (seq: number) => {
    if (
      !(await confirm({
        title: `Delete message #${seq}?`,
        message: 'The message is removed from the stream. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteStreamMessage(connId, stream.name, seq);
      reload();
      onChanged();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  // The server answers a page in sequence order; the tail collects newest
  // first. Whichever way the table is sorted, the two have to meet.
  const pageMessages = page ? (desc ? [...page.messages].reverse() : page.messages) : [];
  const tail = onNewestPage ? liveMsgs.filter(m => !page || m.seq > page.pageEnd) : [];
  const messages = desc ? [...tail, ...pageMessages] : [...pageMessages, ...[...tail].reverse()];
  const liveSeqs = new Set(tail.map(m => m.seq));
  // Two messages with one deduplication id, on a page: the window between
  // them had passed, or the id is not unique. Either is worth pointing at.
  const repeated = repeatedIds(messages);

  return (
    <div className="flex flex-col h-full min-h-0">
      <StreamMessagesToolbar
        connId={connId}
        streamName={stream.name}
        first={first}
        last={last}
        pageStart={pageStart}
        pageEnd={pageEnd}
        pageEmpty={!page || page.messages.length === 0}
        onStart={setStartSeq}
        limit={limit}
        onLimit={setLimit}
        messages={messages}
        live={live}
        tailCount={tail.length}
        onToggleLive={toggleLive}
        loading={loading && !initial}
        onReload={reload}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        {chart && <StreamChart connId={connId} stream={stream.name} spec={chart} live={live} onChange={setChart} onClose={() => setChart(null)} />}
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot load messages" message={error} action={<Button onClick={reload}>Retry</Button>} />
        ) : messages.length === 0 && !live ? (
          <EmptyState
            compact
            title="No messages in this range"
            description={stream.state.messages === 0 ? 'The stream is empty.' : 'Messages in this range were deleted.'}
          />
        ) : (
          <table className="table table-fixed">
            <colgroup>
              <col className="w-8" />
              <col style={{ width: widths.seq }} />
              <col style={{ width: widths.time }} />
              <col style={{ width: widths.subject }} />
              {/* Payload takes what the others leave. */}
              <col />
              <col style={{ width: widths.size }} />
              <col className="w-10" />
            </colgroup>
            <thead>
              {/*
                The header cells are `sticky`, and that is already a
                containing block: the grips position themselves against the
                cell without a `relative` that would undo the stickiness.
              */}
              <tr>
                <th />
                <th className="num" aria-sort={desc ? 'descending' : 'ascending'}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-fg"
                    onClick={() => setDesc(v => !v)}
                    title={desc ? 'Sorted newest first — click for oldest first' : 'Sorted oldest first — click for newest first'}
                  >
                    Seq
                    {desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                  </button>
                  <ColumnGrip {...resize('seq')} />
                </th>
                <th>
                  Time
                  <ColumnGrip {...resize('time')} />
                </th>
                <th>
                  Subject
                  <ColumnGrip {...resize('subject')} />
                </th>
                <th>Payload</th>
                {/* Size sits between the flexible payload column and the
                    fixed one holding the delete button, so its right edge
                    cannot move: the line to grab is the one on its left. */}
                <th className="num">
                  Size
                  <ColumnGrip {...resize('size', 'left')} />
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {messages.length === 0 && live && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    Waiting for new messages…
                  </td>
                </tr>
              )}
              {messages.map(m => (
                <StreamMessageRow
                  key={m.seq}
                  m={m}
                  open={open === m.seq}
                  live={liveSeqs.has(m.seq)}
                  canWrite={canWrite}
                  denyDelete={stream.denyDelete}
                  chartField={chart?.field ?? null}
                  charting={!!chart}
                  repeatedId={(() => {
                    const id = msgId(m.headers);
                    return !!id && repeated.has(id);
                  })()}
                  onToggle={() => setOpen(open === m.seq ? null : m.seq)}
                  onDelete={() => del(m.seq)}
                  onFieldSelect={(field, subject) =>
                    setChart(c => (c?.field === field && c.subject === subject ? null : { field, subject, last: c?.last ?? 2000 }))
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
