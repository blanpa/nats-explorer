import type { NatsMessage } from 'shared';
import { messageKey } from '../../lib/messages';
import { cn, formatBytes, formatTime, previewPayload } from '../../lib/utils';
import { VirtualRows } from '../ui/VirtualRows';

const ROW = 40;

interface Props {
  /** oldest first; rendered newest first */
  messages: NatsMessage[];
  active: NatsMessage | undefined;
  onPick: (m: NatsMessage) => void;
}

/** The message history of a subject as a narrow, virtualized rail. */
export default function HistoryRail({ messages, active, onPick }: Props) {
  return (
    <div className="w-72 shrink-0 border-r border-line flex flex-col min-h-0">
      <div className="flex items-center h-9 px-3 border-b border-line text-xs text-muted">
        <span className="section-title">History</span>
        <span className="ml-auto">{messages.length} newest first</span>
      </div>
      <VirtualRows
        className="flex-1 min-h-0"
        count={messages.length}
        rowHeight={ROW}
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
