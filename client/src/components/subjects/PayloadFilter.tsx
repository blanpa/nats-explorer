import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useStore } from '../../store';
import { cn, readSetting, writeSetting } from '../../lib/utils';
import { Input } from '../ui/Input';

const OPEN_KEY = 'ne.payloadFilterOpen';

/** Examples that show the shape of an expression without a manual. */
const EXAMPLES = [
  { label: 'value over a threshold', expr: 'payload.temp > 80' },
  { label: 'a field is set', expr: 'has(payload.alarm)' },
  { label: 'text in the payload', expr: 'raw.contains("error")' },
  { label: 'subject and payload', expr: 'subject.endsWith(".temp") && payload.unit == "C"' },
  // Only useful with a pinned schema, and then it is the most useful one.
  { label: 'does not match the pinned schema', expr: '!valid' },
];

/**
 * The payload filter: a CEL expression the server evaluates against the last
 * message of every subject, so only matching subjects stay in the tree and
 * the history queries follow. A panel like the ones above it, and collapsed
 * it still says what it is filtering, because that explains a thin tree.
 */
export default function PayloadFilter() {
  const expr = useStore(s => s.subjectExpr);
  const setExpr = useStore(s => s.setSubjectExpr);
  const error = useStore(s => s.filterError);
  const [open, setOpen] = useState<boolean | null>(() => readSetting<boolean | null>(OPEN_KEY, null));
  const [text, setText] = useState(expr);
  const inputRef = useRef<HTMLInputElement>(null);
  // Open by itself while a filter is active, so it is never hidden.
  const isOpen = open ?? !!expr;

  // The store is the source of truth; typing catches up after a short pause.
  useEffect(() => setText(expr), [expr]);
  useEffect(() => {
    if (text === expr) return;
    const t = setTimeout(() => setExpr(text), 400);
    return () => clearTimeout(t);
  }, [text, expr, setExpr]);

  const toggle = () => {
    const next = !isOpen;
    writeSetting(OPEN_KEY, next);
    setOpen(next);
    if (next) setTimeout(() => inputRef.current?.focus(), 0);
  };

  const clear = () => {
    setText('');
    setExpr('');
  };

  return (
    <div className="border-b border-line" role="group" aria-label="Payload filter">
      <button
        type="button"
        className="w-full flex items-center gap-1.5 h-7 px-2 text-xs text-muted hover:text-fg"
        onClick={toggle}
        aria-expanded={isOpen}
        title={expr || 'Filter subjects by their last payload, with a CEL expression'}
      >
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="font-semibold shrink-0">Payload filter</span>
        {!isOpen && expr && <span className={cn('font-mono truncate ml-1', error ? 'text-danger' : 'text-accent')}>{error ? 'invalid expression' : expr}</span>}
        {!expr && <span className="ml-auto text-faint shrink-0">off</span>}
      </button>

      {isOpen && (
        <div className="px-2 pb-2">
          <div className="relative">
            <Input
              ref={inputRef}
              mono
              inputSize="sm"
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  clear();
                }
              }}
              placeholder="payload.temp > 80"
              aria-label="Payload filter expression"
              aria-invalid={!!error}
              spellCheck={false}
              className={cn('pr-7', error && 'border-danger')}
            />
            {text && (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-faint hover:text-fg"
                onClick={clear}
                aria-label="Clear the payload filter"
              >
                <X size={12} />
              </button>
            )}
          </div>
          {error ? (
            <p className="text-[11px] text-danger mt-1 font-mono break-words" role="alert">
              {error}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1 mt-1">
              {EXAMPLES.map(e => (
                <button
                  key={e.expr}
                  type="button"
                  className="text-[10px] font-mono text-faint hover:text-accent border border-line rounded px-1 py-0.5"
                  title={e.label}
                  onClick={() => setText(e.expr)}
                >
                  {e.expr}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
