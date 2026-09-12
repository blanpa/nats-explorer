import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Route } from 'lucide-react';
import type { NatsMessage } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { traceCandidates, traceSteps } from '../../lib/trace';
import { formatDurationMs, formatTime, previewPayload } from '../../lib/utils';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';
import { EmptyState, Segmented } from '../ui/misc';
import { toneClass } from '../ui/tone';

/** How many hits a trace shows; a value that occurs more than this is not an id. */
const LIMIT = 200;

/**
 * One thing followed through several subjects.
 *
 * A request and its reply, an order and its shipment, a saga across five
 * services: the messages belong together and live on different subjects, and
 * what ties them is a value inside them. The recorded history is searched
 * for that value across every subject, and the hits become a list in time
 * order with the gap between each -- which is where "it stopped here" is
 * visible.
 */
export default function TraceDialog({ message, onClose }: { message: NatsMessage; onClose: () => void }) {
  const candidates = useMemo(() => traceCandidates(message), [message]);
  const [value, setValue] = useState(candidates[0]?.value ?? '');
  const [hits, setHits] = useState<NatsMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revealSubject = useStore(s => s.revealSubject);

  useEffect(() => {
    const q = value.trim();
    if (!q) return;
    let live = true;
    setBusy(true);
    // No subject: across every recorded subject, which is the point.
    api
      .searchHistory('', q, { limit: LIMIT })
      .then(r => live && (setHits(r.messages), setError(null)))
      .catch(e => live && (setError(errorMessage(e)), setHits(null)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [value]);

  const steps = traceSteps(hits ?? []);
  const span = steps.length > 1 ? steps[steps.length - 1].message.timestamp - steps[0].message.timestamp : 0;

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title="Follow this through the subjects"
      description="Every recorded message carrying the same value, in time order, with the gap between each."
      width="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        {candidates.length > 1 && (
          <Segmented
            size="xs"
            value={candidates.find(c => c.value === value)?.label ?? ''}
            onChange={l => setValue(candidates.find(c => c.label === l)?.value ?? value)}
            options={candidates.map(c => ({ id: c.label, label: c.label }))}
          />
        )}
        <Field label="Value" hint="Searched across every recorded subject, by the same index the history search uses.">
          <Input mono value={value} onChange={e => setValue(e.target.value)} placeholder="ORD-1089" spellCheck={false} />
        </Field>

        {error && (
          <div className="text-sm text-danger" role="alert">
            {error}
          </div>
        )}

        {steps.length > 0 && (
          <>
            <div className="text-xs text-muted">
              {steps.length} message{steps.length === 1 ? '' : 's'} on {new Set(steps.map(s => s.message.subject)).size} subject
              {new Set(steps.map(s => s.message.subject)).size === 1 ? '' : 's'}
              {span > 0 && <> · {formatDurationMs(span)} from first to last</>}
            </div>
            <div className="card divide-y divide-line/70 max-h-[340px] overflow-auto">
              {steps.map(({ message: m, gap }) => {
                const p = previewPayload(m.payload, m.payloadType, 70);
                return (
                  <button
                    type="button"
                    key={`${m.subject}-${m.timestamp}-${m.sequence ?? 0}`}
                    className="w-full text-left px-3 py-1.5 flex items-baseline gap-3 hover:bg-field/50"
                    onClick={() => {
                      revealSubject(m.subject);
                      onClose();
                    }}
                    title={`Open ${m.subject}`}
                  >
                    <span className="font-mono text-xs text-muted w-24 shrink-0 tabular-nums">{formatTime(m.timestamp)}</span>
                    <span className="font-mono text-xs w-16 shrink-0 text-right text-faint tabular-nums">
                      {gap === null ? '' : `+${formatDurationMs(gap)}`}
                    </span>
                    <span className="font-mono text-xs text-syn-key truncate max-w-[280px]">{m.subject}</span>
                    <span className={`font-mono text-xs truncate ${toneClass[p.tone]}`}>{p.text}</span>
                  </button>
                );
              })}
            </div>
            <div className="text-xs text-faint flex items-center gap-1">
              <ArrowRight size={12} /> A row opens its subject. The gap is to the message before it, not to this one’s own producer.
            </div>
          </>
        )}

        {!busy && steps.length === 0 && value.trim() && !error && (
          <EmptyState
            compact
            icon={Route}
            title="Nothing else carries this value"
            description="Only messages that were recorded can be followed; a subject nobody was subscribed to has none."
          />
        )}
      </div>
    </Dialog>
  );
}
