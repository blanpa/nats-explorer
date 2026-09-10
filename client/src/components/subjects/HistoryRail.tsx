import { Loader2 } from 'lucide-react';
import type { NatsMessage } from 'shared';
import { messageKey } from '../../lib/messages';
import { cn, formatBytes, formatCount, formatTime, previewPayload } from '../../lib/utils';
import { VirtualRows } from '../ui/VirtualRows';

const ROW = 40;

interface Props {
  /** oldest first; rendered newest first */
  messages: NatsMessage[];
  active: NatsMessage | undefined;
  onPick: (m: NatsMessage) => void;
  /** fetch the messages before the oldest one shown; called when the end comes into view */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  /** nothing older is left to fetch */
  atOldest?: boolean;
  /** width in pixels; the pane is draggable */
  width: number;
}

/**
 * The message history of a subject as a narrow, virtualized rail. It is
 * rendered newest first and pages backwards as it is scrolled, so the list
 * is not limited to what the first request brought.
 */
export default function HistoryRail({ messages, active, onPick, onLoadOlder, loadingOlder, atOldest, width }: Props) {
  const paging = !!onLoadOlder;
  return (
    <div className="shrink-0 border-r border-line flex flex-col min-h-0" style={{ width }}>
      <div className="flex items-center h-9 px-3 border-b border-line text-xs text-muted">
        <span className="section-title">History</span>
        <span className="ml-auto">{formatCount(messages.length)} newest first</span>
      </div>
      <VirtualRows
        className="flex-1 min-h-0"
        count={messages.length}
        rowHeight={ROW}
        onEndReached={onLoadOlder}
        footer={
          paging && messages.length > 0 ? (
            <div className="h-9 flex items-center justify-center gap-1.5 text-xs text-faint border-t border-line">
              {loadingOlder ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> Loading older…
                </>
              ) : atOldest ? (
                'No older messages'
              ) : (
                <button type="button" className="hover:text-fg" onClick={onLoadOlder}>
                  Load older
                </button>
              )}
            </div>
          ) : null
        }
        rowKey={i => messageKey(messages[messages.length - 1 - i])}
        renderRow={i => {
          const m = messages[messages.length - 1 - i];
          const p = previewPayload(m.payload, m.payloadType, 48);
          return (
            <div className={cn('list-row h-full py-0', m === active && 'list-row-active')} onClick={() => onPick(m)}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-muted">{formatTime(m.timestamp)}</span>
                  <span className="ml-auto text-faint">{formatBytes(m.size)}</span>
                </div>
                <div className="font-mono text-xs truncate text-fg/80">{p.text}</div>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
