import { Loader2 } from 'lucide-react';
import type { NatsMessage } from 'shared';
import { messageKey } from '../../lib/messages';
import { cn, formatBytes, formatTime, previewPayload } from '../../lib/utils';
import { ColumnGrip, useColumnWidths } from '../ui/columns';
import { SubjectText } from '../ui/SubjectText';
import { toneClass } from '../ui/tone';
import { VirtualRows } from '../ui/VirtualRows';

const ROW = 30;
const DEFAULT_WIDTHS = { time: 96, subject: 280, size: 64 };

interface Props {
  /** newest first */
  messages: NatsMessage[];
  /** prefix rendered faintly in front of the subject, e.g. the selected branch */
  subjectPrefix?: string;
  onOpen: (subject: string) => void;
  /** when given, a click selects the message instead of opening its subject */
  onSelect?: (message: NatsMessage) => void;
  selected?: NatsMessage | null;
  className?: string;
  /** fetch what is older than the last row; called when the end comes into view */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  /** nothing older is left to fetch */
  atOldest?: boolean;
}

/**
 * A virtualized time/subject/payload/size table. A click shows the message
 * where a caller offers `onSelect`, otherwise it opens the row's subject.
 * The time, subject and size columns can be dragged; the payload takes what
 * is left.
 */
export default function MessageList({ messages, subjectPrefix, onOpen, onSelect, selected, className, onLoadOlder, loadingOlder, atOldest }: Props) {
  const { widths, resize } = useColumnWidths('ne.messageListCols', DEFAULT_WIDTHS);
  const grid = { gridTemplateColumns: `${widths.time}px ${widths.subject}px minmax(0, 1fr) ${widths.size}px` };

  const header = (
    <div className="grid gap-3 px-3 h-8 items-center text-xs font-medium text-muted border-b border-line bg-panel" style={grid}>
      <span className="relative">
        Time
        <ColumnGrip {...resize('time')} />
      </span>
      <span className="relative">
        Subject
        <ColumnGrip {...resize('subject')} />
      </span>
      <span>Payload</span>
      <span className="relative text-right">
        Size
        <ColumnGrip {...resize('size')} />
      </span>
    </div>
  );
  return (
    <VirtualRows
      className={className}
      count={messages.length}
      rowHeight={ROW}
      rowKey={i => messageKey(messages[i])}
      header={header}
      onEndReached={onLoadOlder}
      footer={
        onLoadOlder && messages.length > 0 ? (
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
      renderRow={i => {
        const m = messages[i];
        const p = previewPayload(m.payload, m.payloadType, 90);
        const below = subjectPrefix && m.subject.startsWith(`${subjectPrefix}.`) ? m.subject.slice(subjectPrefix.length + 1) : null;
        return (
          <div
            className={cn(
              'grid gap-3 px-3 h-full items-center text-sm border-b border-line/70 cursor-pointer hover:bg-field/50',
              selected && messageKey(selected) === messageKey(m) && 'bg-accent/10',
            )}
            style={grid}
            onClick={() => (onSelect ? onSelect(m) : onOpen(m.subject))}
            title={onSelect ? 'Show this message' : 'Open this subject'}
          >
            <span className="font-mono text-muted text-xs truncate">{formatTime(m.timestamp)}</span>
            {below !== null ? (
              <span className="font-mono truncate">
                <span className="text-faint">{subjectPrefix}.</span>
                {below}
              </span>
            ) : (
              <SubjectText subject={m.subject} />
            )}
            <span className={cn('font-mono truncate', toneClass[p.tone])}>{p.text}</span>
            <span className="text-right font-mono tabular-nums text-muted text-xs truncate">{formatBytes(m.size)}</span>
          </div>
        );
      }}
    />
  );
}
