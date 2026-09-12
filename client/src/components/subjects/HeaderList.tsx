import { AlertTriangle } from 'lucide-react';
import { describeHeader, isNatsHeader, msgId } from '../../lib/natsHeaders';
import { cn } from '../../lib/utils';
import { Hint } from '../ui/misc';

/**
 * The headers of a message, with the meaning of the ones NATS set.
 *
 * A publisher's own headers are shown as they are; the server's carry a mark
 * that explains what they do, because a list that reads
 * `Nats-Expected-Last-Subject-Sequence: 41` is only useful to someone who
 * already knows what it means -- and someone who already knows is not the
 * one reading it.
 */
export default function HeaderList({
  headers,
  repeated,
  compact,
}: {
  headers: Record<string, string[]>;
  /** the message id occurs more than once among the messages loaded here */
  repeated?: boolean;
  compact?: boolean;
}) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return null;
  const dedupe = msgId(headers);
  return (
    <div className={cn('divide-y divide-line/70 font-mono', compact ? 'text-xs' : 'card text-sm')}>
      {entries.map(([k, vals]) => {
        const what = describeHeader(k, vals);
        const isDuplicateId = repeated && k.toLowerCase() === 'nats-msg-id';
        return (
          <div key={k} className={cn('flex gap-3', compact ? 'py-0.5' : 'px-3 py-1.5')}>
            <span className={cn('shrink-0 truncate flex items-center gap-1', compact ? 'w-56' : 'w-64', isNatsHeader(k) ? 'text-syn-key' : 'text-muted')}>
              {k}
              {what && <Hint text={what} />}
            </span>
            <span className="text-syn-str break-all min-w-0">{vals.join(', ')}</span>
            {isDuplicateId && (
              <span
                className="ml-auto shrink-0 text-warn flex items-center gap-1 font-sans text-xs"
                title={`${dedupe} occurs more than once among the messages loaded here`}
              >
                <AlertTriangle size={12} /> id seen twice
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
