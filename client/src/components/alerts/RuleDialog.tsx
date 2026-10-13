import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import type { AlertAgg, AlertRule, AlertSeverity, AlertTestResult, WebhookFormat } from 'shared';
import { errorMessage } from '../../lib/api';
import { alertsApi } from '../../lib/api.alerts';
import { validateRule } from '../../lib/alerts';
import { useAlerts } from '../../store/alerts';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Checkbox, Field, Input, Select } from '../ui/Input';
import { SectionTitle } from '../ui/misc';
import { toast } from '../ui/Toast';

/** Starting points for a rule, including the one a pinned schema unlocks. */
const EXPRESSIONS = [
  { label: 'the payload does not match the schema pinned for the subject', expr: '!valid' },
  { label: 'a value over a threshold', expr: 'payload.temp > 80' },
  { label: 'a field is set', expr: 'has(payload.alarm)' },
];

/** An optional number from a field: empty is "not set", not zero. */
function optional(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const shown = (n: number | undefined) => (n === undefined ? '' : String(n));

/** Create or edit one alert rule, with a dry run against the recorded messages. */
export default function RuleDialog({ rule, onClose }: { rule: AlertRule; onClose: () => void }) {
  const save = useAlerts(s => s.save);
  const [draft, setDraft] = useState<AlertRule>(rule);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<AlertTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const patch = (p: Partial<AlertRule>) => setDraft(d => ({ ...d, ...p }));
  const problem = validateRule({ ...draft, name: draft.name.trim() || draft.pattern.trim() });
  const ready = !problem;
  const hasWindow = (draft.window ?? 0) > 0;

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
      description="A rule fires while a condition holds for a subject: an expression, a silence, a count or a threshold over a window, or a value that stopped changing."
      width="lg"
      footer={
        <>
          {problem && draft.pattern.trim() && <span className="text-xs text-muted mr-auto">{problem}</span>}
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

        <SectionTitle>Per message</SectionTitle>
        <Field
          label="Expression"
          hint="CEL over subject, payload, headers, size, timestamp, kind and valid. Evaluated on every message; leave empty for the other conditions."
        >
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

        <SectionTitle>Silence</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field
            label={draft.staleAuto ? 'Not before (s)' : 'Silent after (s)'}
            hint={draft.staleAuto ? 'A floor under the learned threshold; 0 leaves it to the subject.' : '0 turns it off.'}
          >
            <Input type="number" min={0} value={draft.staleAfter ?? 0} onChange={e => patch({ staleAfter: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <div className="md:col-span-2">
            {/* A plant has two thousand subjects sending at a dozen rates, and
                nobody maintains a timeout per subject. The gaps between the
                messages already say what normal is. */}
            <Checkbox
              label="Learn each subject's own rhythm"
              description="Each subject is reported after ten times its usual gap between messages — a sensor sending every five seconds after a minute, an hourly batch after ten hours. A subject that has not sent at least eight times is never reported."
              checked={!!draft.staleAuto}
              onChange={e => patch({ staleAuto: e.target.checked })}
            />
          </div>
        </div>

        {/* One message cannot say that too few arrived in the last minute or
            that the average of the last five is past a threshold. A window
            can, and it costs the same whether the subject sends once an hour
            or a thousand times a second. */}
        <SectionTitle>Over a window</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Window (s)" hint="The last this many seconds, checked once a second. Empty turns the counts and the threshold off.">
            <Input type="number" min={0} max={86400} value={shown(draft.window)} onChange={e => patch({ window: optional(e.target.value) })} placeholder="60" />
          </Field>
          <Field label="Fewer than … messages" hint="Judged once the subject has been watched for a whole window.">
            <Input type="number" min={0} value={shown(draft.minCount)} disabled={!hasWindow} onChange={e => patch({ minCount: optional(e.target.value) })} />
          </Field>
          <Field label="More than … messages">
            <Input type="number" min={0} value={shown(draft.maxCount)} disabled={!hasWindow} onChange={e => patch({ maxCount: optional(e.target.value) })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Field" hint="A dotted path into the payload, for the threshold and the unchanged check.">
            <Input mono value={draft.field ?? ''} onChange={e => patch({ field: e.target.value })} placeholder="temp" spellCheck={false} />
          </Field>
          <Field label="Reduced as">
            <Select value={draft.agg ?? 'avg'} disabled={!hasWindow} onChange={e => patch({ agg: e.target.value as AlertAgg })}>
              <option value="avg">average</option>
              <option value="min">minimum</option>
              <option value="max">maximum</option>
            </Select>
          </Field>
          <Field label="Above">
            <Input type="number" value={shown(draft.above)} disabled={!hasWindow} onChange={e => patch({ above: optional(e.target.value) })} placeholder="80" />
          </Field>
          <Field label="Below">
            <Input type="number" value={shown(draft.below)} disabled={!hasWindow} onChange={e => patch({ below: optional(e.target.value) })} />
          </Field>
        </div>

        <SectionTitle>Stuck</SectionTitle>
        <Field
          label="Unchanged for (s)"
          hint="Reported again without changing for this long: the field above, or the whole payload without one. A sensor that is stuck sends on time, which no other condition can tell from one that is fine. 0 turns it off."
        >
          <Input type="number" min={0} value={shown(draft.unchangedFor)} onChange={e => patch({ unchangedFor: optional(e.target.value) })} />
        </Field>

        <SectionTitle>Notify</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Severity">
            <Select value={draft.severity} onChange={e => patch({ severity: e.target.value as AlertSeverity })}>
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="critical">critical</option>
            </Select>
          </Field>
          <Field label="Webhook" hint="Optional URL, receives a POST on every change.">
            <Input mono value={draft.webhook ?? ''} onChange={e => patch({ webhook: e.target.value })} placeholder="https://…" />
          </Field>
          <Field label="Webhook format" hint="Slack and Teams incoming webhooks want their own shape; JSON is for everything else.">
            <Select
              value={draft.webhookFormat ?? 'json'}
              disabled={!draft.webhook?.trim()}
              onChange={e => patch({ webhookFormat: e.target.value as WebhookFormat })}
            >
              <option value="json">JSON</option>
              <option value="slack">Slack</option>
              <option value="teams">Microsoft Teams</option>
            </Select>
          </Field>
        </div>
        <Field label="Email" hint="Recipients, comma separated. The server sends them through SMTP_HOST; without it the log says so.">
          <Input mono value={draft.email ?? ''} onChange={e => patch({ email: e.target.value })} placeholder="ops@example.com, oncall@example.com" />
        </Field>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<FlaskConical size={13} />} disabled={!draft.pattern.trim()} onClick={runTest}>
            Test the expression against history
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
