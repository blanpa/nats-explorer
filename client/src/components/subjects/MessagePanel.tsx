import { ArrowUpRight, X } from 'lucide-react';
import type { NatsMessage } from 'shared';
import { formatBytes, formatTime } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import PayloadViewer from './PayloadViewer';

/**
 * One message under a list: its payload, where the list itself has no room
 * for it. Used by the search results and the branch view, so clicking a row
 * shows what is inside, as it does in the live view.
 */
export default function MessagePanel({
  message,
  onClose,
  onOpenSubject,
  maxHeight = 260,
}: {
  message: NatsMessage;
  onClose: () => void;
  /** offered when the message belongs to another subject than the one shown */
  onOpenSubject?: (subject: string) => void;
  maxHeight?: number;
}) {
  return (
    <div className="shrink-0 border-t border-line bg-panel/40 px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5 text-xs text-muted">
        <span className="font-mono text-fg truncate">{message.subject}</span>
        <span className="font-mono">{formatTime(message.timestamp)}</span>
        <span>{formatBytes(message.size)}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {onOpenSubject && (
            <Button size="xs" variant="outline" icon={<ArrowUpRight size={12} />} onClick={() => onOpenSubject(message.subject)}>
              Open subject
            </Button>
          )}
          <IconButton label="Close this message" size="xs" onClick={onClose}>
            <X size={12} />
          </IconButton>
        </div>
      </div>
      <PayloadViewer compact payload={message.payload} type={message.payloadType} subject={message.subject} size={message.size} maxHeight={maxHeight} />
    </div>
  );
}
