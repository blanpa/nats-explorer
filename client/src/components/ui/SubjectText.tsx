import { cn } from '../../lib/utils';

/**
 * A subject that keeps its tail readable when space runs out: the leading
 * segments shrink and truncate, the last two stay.
 */
export function SubjectText({ subject, tail = 2, className }: { subject: string; tail?: number; className?: string }) {
  const parts = subject.split('.');
  if (parts.length <= tail) return <span className={cn('font-mono truncate', className)}>{subject}</span>;
  const head = `${parts.slice(0, -tail).join('.')}.`;
  return (
    <span className={cn('font-mono flex min-w-0', className)} title={subject}>
      <span className="truncate text-muted">{head}</span>
      <span className="shrink-0">{parts.slice(-tail).join('.')}</span>
    </span>
  );
}
