import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import type { AlertRule, AlertSeverity, AlertTestResult } from 'shared';
import { errorMessage } from '../../lib/api';
import { alertsApi } from '../../lib/api.alerts';
import { useAlerts } from '../../store/alerts';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select } from '../ui/Input';
import { toast } from '../ui/Toast';

/** Starting points for a rule, including the one a pinned schema unlocks. */
const EXPRESSIONS = [
  { label: 'the payload does not match the schema pinned for the subject', expr: '!valid' },
  { label: 'a value over a threshold', expr: 'payload.temp > 80' },
  { label: 'a field is set', expr: 'has(payload.alarm)' },
];

/** Create or edit one alert rule, with a dry run against the recorded messages. */
export default function RuleDialog({ rule, onClose }: { rule: AlertRule; onClose: () => void }) {
  const save = useAlerts(s => s.save);
  const [draft, setDraft] = useState<AlertRule>(rule);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<AlertTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const patch = (p: Partial<AlertRule>) => setDraft(d => ({ ...d, ...p }));
  const ready = draft.pattern.trim().length > 0 && (!!draft.expr?.trim() || !!draft.staleAfter);

  const runTest = async () => {
    setTestError(null);
    setTest(null);
    try {
      setTest(await alertsApi.test(draft));
    } catch (err) {
      setTestError(errorMessage(err));
    }
  };

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await save({ ...draft, name: draft.name.trim() || draft.pattern.trim(), pattern: draft.pattern.trim() });
      onClose();
    } catch (err) {
      toast.error('Could not save the rule', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title={rule.name ? `Edit ${rule.name}` : 'New alert rule'}
      description="A rule fires while its expression holds for a subject, or when a subject stops sending."
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || busy} onClick={submit}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={draft.name} onChange={e => patch({ name: e.target.value })} placeholder="Line 1 too hot" autoFocus />
          </Field>
          <Field label="Subject pattern" hint="NATS wildcards: * for one token, > for the rest.">
            <Input mono value={draft.pattern} onChange={e => patch({ pattern: e.target.value })} placeholder="plant.line1.>" />
          </Field>
        </div>

        <Field label="Expression" hint="CEL over subject, payload, headers, size, timestamp, kind and valid. Leave empty to alert only on silence.">
          <Input mono value={draft.expr ?? ''} onChange={e => patch({ expr: e.target.value })} placeholder="payload.temp > 80" spellCheck={false} />
        </Field>
        {/* A pinned schema needs no rule type of its own: the same expression
            language already carries the verdict. */}
        <div className="flex flex-wrap items-center gap-1 -mt-1">
          <span className="text-xs text-faint">Start from</span>
          {EXPRESSIONS.map(e => (
            <button
              key={e.expr}
              type="button"
              className="text-2xs font-mono text-faint hover:text-accent border border-line rounded px-1 py-0.5"
              title={e.label}
              onClick={() => patch({ expr: e.expr })}
            >
              {e.expr}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Silent after (s)" hint="0 turns it off.">
            <Input type="number" min={0} value={draft.staleAfter ?? 0} onChange={e => patch({ staleAfter: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Field label="Severity">
            <Select value={draft.severity} onChange={e => patch({ severity: e.target.value as AlertSeverity })}>
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="critical">critical</option>
            </Select>
          </Field>
          <Field label="Webhook" hint="Optional URL, receives a JSON POST on every change.">
            <Input mono value={draft.webhook ?? ''} onChange={e => patch({ webhook: e.target.value })} placeholder="https://…" />
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<FlaskConical size={13} />} disabled={!draft.pattern.trim()} onClick={runTest}>
            Test against history
          </Button>
          {test && <span className="text-xs text-muted">{test.note ?? `${test.matched} of ${test.sampled} recorded messages match.`}</span>}
          {testError && (
            <span className="text-xs text-danger" role="alert">
              {testError}
            </span>
          )}
        </div>

        {test && test.matches.length > 0 && (
          <div className="card divide-y divide-line/70 max-h-[180px] overflow-auto text-xs font-mono">
            {test.matches.map((m, i) => (
              <div key={`${m.subject}-${m.sequence ?? i}`} className="flex gap-3 px-3 py-1.5">
                <span className="text-syn-key shrink-0 truncate max-w-[200px]">{m.subject}</span>
                <span className="text-muted truncate">{m.payload}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
