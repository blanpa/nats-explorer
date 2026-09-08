import { useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Radio, RefreshCw } from 'lucide-react';
import type { StreamMessage } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { Button, IconButton } from '../ui/Button';
import { Input, Select } from '../ui/Input';
import { toast } from '../ui/Toast';
import ExportMenu from '../subjects/ExportMenu';

interface Props {
  connId: string;
  streamName: string;
  /** sequence bounds of the stream and of the page shown */
  first: number;
  last: number;
  pageStart: number;
  pageEnd: number;
  pageEmpty: boolean;
  /** undefined starts at the newest page */
  onStart: (seq: number | undefined) => void;
  limit: number;
  onLimit: (n: number) => void;
  /** what the export menu writes */
  messages: StreamMessage[];
  live: boolean;
  tailCount: number;
  onToggleLive: () => void;
  loading: boolean;
  onReload: () => void;
}

/** Paging, jump to sequence or time, page size, export, live tail and reload. */
export default function StreamMessagesToolbar({
  connId,
  streamName,
  first,
  last,
  pageStart,
  pageEnd,
  pageEmpty,
  onStart,
  limit,
  onLimit,
  messages,
  live,
  tailCount,
  onToggleLive,
  loading,
  onReload,
}: Props) {
  const [jump, setJump] = useState('');
  const [jumpTime, setJumpTime] = useState('');
  const canPrev = pageStart > first;
  const canNext = pageEnd < last && pageEnd > 0;

  const jumpTo = () => {
    const n = Number(jump);
    if (Number.isFinite(n) && n > 0) onStart(Math.floor(n));
  };

  // A point in time becomes the first sequence stored at or after it.
  const jumpToTime = async () => {
    const ms = new Date(jumpTime).getTime();
    if (!Number.isFinite(ms)) return;
    try {
      const at = await api.getStreamSeqAt(connId, streamName, ms);
      onStart(Math.min(Math.max(at.seq, at.firstSeq), at.lastSeq || at.firstSeq));
    } catch (err) {
      toast.error('Cannot find that time', errorMessage(err));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line text-xs text-muted">
      <IconButton label="Oldest" size="xs" disabled={!canPrev} onClick={() => onStart(first)}>
        <ChevronsLeft size={13} />
      </IconButton>
      <IconButton label="Older" size="xs" disabled={!canPrev} onClick={() => onStart(Math.max(first, pageStart - limit))}>
        <ChevronLeft size={13} />
      </IconButton>
      <span className="font-mono tabular-nums">
        {pageEmpty ? 'no messages' : `${pageStart}–${pageEnd}`}{' '}
        <span className="text-faint">
          of seq {first}–{last}
        </span>
      </span>
      <IconButton label="Newer" size="xs" disabled={!canNext} onClick={() => onStart(pageEnd + 1)}>
        <ChevronRight size={13} />
      </IconButton>
      <IconButton label="Newest" size="xs" disabled={!canNext} onClick={() => onStart(undefined)}>
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
      <form
        className="flex items-center gap-1"
        onSubmit={e => {
          e.preventDefault();
          void jumpToTime();
        }}
      >
        <Input
          inputSize="sm"
          type="datetime-local"
          step={1}
          className="w-48"
          value={jumpTime}
          onChange={e => setJumpTime(e.target.value)}
          aria-label="Go to time"
          title="Jump to the first message stored at or after this time"
        />
      </form>
      <Select inputSize="sm" className="w-28" value={limit} onChange={e => onLimit(Number(e.target.value))} aria-label="Page size">
        {[25, 50, 100, 200].map(n => (
          <option key={n} value={n}>
            {n} / page
          </option>
        ))}
      </Select>
      <div className="ml-auto flex items-center gap-1">
        <ExportMenu messages={messages} name={`${streamName}-${pageStart}-${pageEnd}`} size="xs" />
        <Button
          size="xs"
          variant="outline"
          active={live}
          icon={<Radio size={12} className={live ? 'text-ok' : undefined} />}
          onClick={onToggleLive}
          title="Append new messages as they arrive"
        >
          Live{live && tailCount > 0 ? ` · ${tailCount}` : ''}
        </Button>
        <IconButton label="Reload" size="xs" loading={loading} onClick={onReload}>
          <RefreshCw size={13} />
        </IconButton>
      </div>
    </div>
  );
}
