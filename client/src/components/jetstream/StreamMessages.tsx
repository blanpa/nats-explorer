import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, ChevronLeft, Radio, RefreshCw, Trash2 } from 'lucide-react';
import type { StreamInfo, StreamMessage, StreamMessagesPage } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useLiveWatch } from '../../lib/live';
import { useJsDomainOverride } from '../../store';
import { cn, formatBytes, formatTime, previewPayload } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Input, Select } from '../ui/Input';
import { confirm } from '../ui/Dialog';
import { EmptyState, ErrorState, LoadingState } from '../ui/misc';
import { toast } from '../ui/Toast';
import PayloadViewer from '../subjects/PayloadViewer';

const toneClass = { str: 'text-syn-str', num: 'text-syn-num', bool: 'text-syn-bool', null: 'text-syn-null', obj: 'text-muted', bin: 'text-muted italic' } as const;

export default function StreamMessages({ connId, stream, onChanged }: { connId: string; stream: StreamInfo; onChanged: () => void }) {
  const domainOverride = useJsDomainOverride(connId);
  const [startSeq, setStartSeq] = useState<number | undefined>(undefined); // undefined = newest page
  const [limit, setLimit] = useState(50);
  const [jump, setJump] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const [liveMsgs, setLiveMsgs] = useState<StreamMessage[]>([]);

  const { data: page, error, loading, initial, reload } = useAsync<StreamMessagesPage>(
    () => api.getStreamMessages(connId, stream.name, { startSeq, limit }),
    [connId, stream.name, startSeq, limit],
    { key: `msgs:${connId}:${stream.name}:${startSeq ?? 'newest'}:${limit}` },
  );

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
  const canPrev = pageStart > first;
  const canNext = pageEnd < last && pageEnd > 0;

  const del = async (seq: number) => {
    if (!(await confirm({ title: `Delete message #${seq}?`, message: 'The message is removed from the stream. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deleteStreamMessage(connId, stream.name, seq);
      reload();
      onChanged();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const jumpTo = () => {
    const n = Number(jump);
    if (Number.isFinite(n) && n > 0) setStartSeq(Math.floor(n));
  };

  const pageMessages = page ? [...page.messages].reverse() : [];
  const tail = onNewestPage ? liveMsgs.filter(m => !page || m.seq > page.pageEnd) : [];
  const messages = [...tail, ...pageMessages];
  const liveSeqs = new Set(tail.map(m => m.seq));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line text-xs text-muted">
        <IconButton label="Oldest" size="xs" disabled={!canPrev} onClick={() => setStartSeq(first)}>
          <ChevronsLeft size={13} />
        </IconButton>
        <IconButton label="Older" size="xs" disabled={!canPrev} onClick={() => setStartSeq(Math.max(first, pageStart - limit))}>
          <ChevronLeft size={13} />
        </IconButton>
        <span className="font-mono tabular-nums">
          {page && page.messages.length > 0 ? `${pageStart}–${pageEnd}` : 'no messages'} <span className="text-faint">of seq {first}–{last}</span>
        </span>
        <IconButton label="Newer" size="xs" disabled={!canNext} onClick={() => setStartSeq(pageEnd + 1)}>
          <ChevronRight size={13} />
        </IconButton>
        <IconButton label="Newest" size="xs" disabled={!canNext} onClick={() => setStartSeq(undefined)}>
          <ChevronsRight size={13} />
        </IconButton>
        <span className="w-px h-4 bg-line mx-1" />
        <form
          className="flex items-center gap-1"
          onSubmit={e => {
            e.preventDefault();
            jumpTo();
          }}
        >
          <Input inputSize="sm" type="number" min={1} className="w-28" placeholder="Go to seq" value={jump} onChange={e => setJump(e.target.value)} />
        </form>
        <Select inputSize="sm" className="w-24" value={limit} onChange={e => setLimit(Number(e.target.value))} aria-label="Page size">
          {[25, 50, 100, 200].map(n => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="outline" active={live} icon={<Radio size={12} className={live ? 'text-ok' : undefined} />} onClick={toggleLive} title="Append new messages as they arrive">
            Live{live && tail.length > 0 ? ` · ${tail.length}` : ''}
          </Button>
          <IconButton label="Reload" size="xs" loading={loading && !initial} onClick={reload}>
            <RefreshCw size={13} />
          </IconButton>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot load messages" message={error} action={<Button onClick={reload}>Retry</Button>} />
        ) : messages.length === 0 && !live ? (
          <EmptyState compact title="No messages in this range" description={stream.state.messages === 0 ? 'The stream is empty.' : 'Messages in this range were deleted.'} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th className="w-8" />
                <th className="num">Seq</th>
                <th>Time</th>
                <th>Subject</th>
                <th>Payload</th>
                <th className="num">Size</th>
                <th className="w-10" />
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
              {messages.map(m => {
                const p = previewPayload(m.payload, m.payloadType, 90);
                const isOpen = open === m.seq;
                return (
                  <Fragment key={m.seq}>
                    <tr className={cn('cursor-pointer', liveSeqs.has(m.seq) && 'bg-ok/5')} onClick={() => setOpen(isOpen ? null : m.seq)}>
                      <td className="text-faint">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                      <td className="num text-muted">{m.seq}</td>
                      <td className="font-mono text-muted">{formatTime(m.timestamp)}</td>
                      <td className="font-mono max-w-[260px] truncate">{m.subject}</td>
                      <td className={cn('font-mono max-w-[420px] truncate', toneClass[p.tone])}>{p.text}</td>
                      <td className="num text-muted">{formatBytes(m.size)}</td>
                      <td>
                        <IconButton
                          label="Delete message"
                          size="xs"
                          disabled={stream.denyDelete}
                          onClick={e => {
                            e.stopPropagation();
                            del(m.seq);
                          }}
                        >
                          <Trash2 size={12} className="text-danger" />
                        </IconButton>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={7} className="!whitespace-normal bg-panel/60 !py-3">
                          <div className="flex flex-col gap-3 max-w-[1100px]">
                            {m.headers && Object.keys(m.headers).length > 0 && (
                              <div className="text-xs font-mono">
                                {Object.entries(m.headers).map(([k, v]) => (
                                  <div key={k}>
                                    <span className="text-syn-key">{k}</span>
                                    <span className="text-faint">: </span>
                                    <span className="text-syn-str">{v.join(', ')}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <PayloadViewer compact payload={m.payload} type={m.payloadType} size={m.size} maxHeight={360} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
