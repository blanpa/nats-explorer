import { useEffect, useState } from 'react';
import { Bell, BellOff, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Alert, AlertRule, AlertSeverity } from 'shared';
import { errorMessage } from '../../lib/api';
import { newAlertRule } from '../../lib/api.alerts';
import { useCanWrite } from '../../lib/auth';
import { cn, formatTime } from '../../lib/utils';
import { useStore } from '../../store';
import { describeEvent, useAlerts } from '../../store/alerts';
import { IconButton } from '../ui/Button';
import { Button } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { Badge, EmptyState, LoadingState, PaneHeader, SectionTitle } from '../ui/misc';
import { toast } from '../ui/Toast';
import RuleDialog from './RuleDialog';

const SEVERITY_TONE: Record<AlertSeverity, 'info' | 'warn' | 'danger'> = { info: 'info', warning: 'warn', critical: 'danger' };

/** How long an alert has been true, in words. */
function sinceText(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function ActiveRow({ alert, onSelect }: { alert: Alert; onSelect: (subject: string) => void }) {
  return (
    <button type="button" className="list-row w-full text-left py-1.5 gap-2" onClick={() => onSelect(alert.subject)} title={`Show ${alert.subject}`}>
      <Badge tone={SEVERITY_TONE[alert.severity]}>{alert.state === 'stale' ? 'silent' : alert.severity}</Badge>
      <span className="font-mono text-xs truncate flex-1">{alert.subject}</span>
      <span className="text-xs text-muted truncate max-w-[220px] hidden md:inline">{alert.ruleName}</span>
      {alert.preview && <span className="text-xs text-faint font-mono truncate max-w-[240px] hidden lg:inline">{alert.preview}</span>}
      <span className="text-xs text-faint tabular-nums shrink-0">{sinceText(alert.since)}</span>
    </button>
  );
}

/**
 * The alerts module: what is true right now, the rules that decide it, and
 * the log of state changes. Rules are evaluated in the backend, so they keep
 * working while no browser is open.
 */
export default function AlertsView() {
  const rules = useAlerts(s => s.rules);
  const active = useAlerts(s => s.active);
  const events = useAlerts(s => s.events);
  const loading = useAlerts(s => s.loading);
  const error = useAlerts(s => s.error);
  const load = useAlerts(s => s.load);
  const save = useAlerts(s => s.save);
  const remove = useAlerts(s => s.remove);
  const revealSubject = useStore(s => s.revealSubject);
  const setModule = useStore(s => s.setModule);
  const canWrite = useCanWrite();
  const [editing, setEditing] = useState<AlertRule | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  const onSelect = (subject: string) => {
    revealSubject(subject);
    setModule('subjects');
  };

  const toggleEnabled = async (rule: AlertRule) => {
    try {
      await save({ ...rule, enabled: !rule.enabled });
    } catch (err) {
      toast.error('Could not change the rule', errorMessage(err));
    }
  };

  const del = async (rule: AlertRule) => {
    if (!(await confirm({ title: `Delete ${rule.name || 'this rule'}?`, message: 'Its alerts disappear with it.', confirmLabel: 'Delete', danger: true })))
      return;
    try {
      await remove(rule.id);
    } catch (err) {
      toast.error('Could not delete the rule', errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        title="Alerts"
        actions={
          canWrite && (
            <Button size="xs" icon={<Plus size={12} />} onClick={() => setEditing(newAlertRule())}>
              New rule
            </Button>
          )
        }
      >
        {active.length > 0 && <Badge tone={active.some(a => a.severity === 'critical') ? 'danger' : 'warn'}>{active.length} active</Badge>}
      </PaneHeader>

      {loading && rules.length === 0 ? (
        <LoadingState />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-5">
          {error && <p className="text-sm text-danger">{error}</p>}

          <div>
            <SectionTitle>Active</SectionTitle>
            {active.length === 0 ? (
              <div className="card px-3 py-4 text-sm text-muted flex items-center gap-2">
                <BellOff size={14} className="text-faint" />
                Nothing is firing.
              </div>
            ) : (
              <div className="card divide-y divide-line/70">
                {active.map(a => (
                  <ActiveRow key={a.key} alert={a} onSelect={onSelect} />
                ))}
              </div>
            )}
          </div>

          <div>
            <SectionTitle>Rules</SectionTitle>
            {rules.length === 0 ? (
              <EmptyState
                compact
                icon={Bell}
                title="No rules yet"
                description="A rule watches a subject pattern for an expression that holds, or for silence."
                action={
                  canWrite && (
                    <Button icon={<Plus size={13} />} onClick={() => setEditing(newAlertRule())}>
                      New rule
                    </Button>
                  )
                }
              />
            ) : (
              <div className="card overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Pattern</th>
                      <th>Condition</th>
                      <th>Severity</th>
                      <th className="num">Firing</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map(r => {
                      const firing = active.filter(a => a.ruleId === r.id).length;
                      return (
                        <tr key={r.id} className={cn(!r.enabled && 'opacity-50')}>
                          <td className="max-w-[220px] truncate">{r.name || <span className="text-faint">unnamed</span>}</td>
                          <td className="font-mono text-muted">{r.pattern}</td>
                          <td className="font-mono text-xs text-muted max-w-[320px] truncate">
                            {r.expr || (r.staleAfter ? `silent for ${r.staleAfter}s` : '–')}
                            {r.expr && r.staleAfter ? ` · silent ${r.staleAfter}s` : ''}
                          </td>
                          <td>
                            <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
                          </td>
                          <td className="num">{firing || <span className="text-faint">0</span>}</td>
                          <td className="whitespace-nowrap text-right">
                            {canWrite && (
                              <>
                                <IconButton label={r.enabled ? 'Disable rule' : 'Enable rule'} size="xs" onClick={() => toggleEnabled(r)}>
                                  {r.enabled ? <Bell size={12} /> : <BellOff size={12} />}
                                </IconButton>
                                <IconButton label="Edit rule" size="xs" onClick={() => setEditing(r)}>
                                  <Pencil size={12} />
                                </IconButton>
                                <IconButton label="Delete rule" size="xs" onClick={() => del(r)}>
                                  <Trash2 size={12} className="text-danger" />
                                </IconButton>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <SectionTitle>Log</SectionTitle>
            {events.length === 0 ? (
              <div className="card px-3 py-4 text-sm text-muted">No state changes yet.</div>
            ) : (
              <div className="card divide-y divide-line/70 max-h-[420px] overflow-auto">
                {events.map((e, i) => (
                  <div key={`${e.time}-${e.subject}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <span className="text-xs text-faint font-mono tabular-nums shrink-0">{formatTime(e.time)}</span>
                    <Badge tone={e.state === 'resolved' ? 'ok' : SEVERITY_TONE[e.severity]}>{e.state}</Badge>
                    <span className="truncate">{describeEvent(e)}</span>
                    {e.webhookError && <span className="text-xs text-danger ml-auto shrink-0">webhook: {e.webhookError}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {editing && <RuleDialog rule={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
