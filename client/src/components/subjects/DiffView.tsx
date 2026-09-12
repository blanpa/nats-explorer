import { useMemo } from 'react';
import { diffLines } from '../../lib/diff';
import { cn } from '../../lib/utils';

export default function DiffView({ prev, curr, maxHeight = 320 }: { prev: string; curr: string; maxHeight?: number }) {
  const ops = useMemo(() => diffLines(prev, curr), [prev, curr]);
  const changed = ops.filter(o => o.type !== 'same').length;

  if (changed === 0) return <div className="text-xs text-muted py-3 text-center">No differences to the previous message.</div>;

  return (
    <div className="code-block p-0 overflow-auto" style={{ maxHeight }}>
      <div className="py-1">
        {ops.map((op, i) => (
          <div key={i} data-marker={op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' '} className={cn('diff-line', `diff-${op.type}`)}>
            {op.line || ' '}
          </div>
        ))}
      </div>
    </div>
  );
}
