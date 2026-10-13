import { useEffect, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bell, BellOff, Check, Eye, EyeOff, Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import type { Alert, AlertRule, AlertSeverity, AlertState, MaintenanceWindow } from 'shared';
import { errorMessage } from '../../lib/api';
import { newAlertRule } from '../../lib/api.alerts';
import { describeMute, describeRule } from '../../lib/alerts';
import { useCanWrite } from '../../lib/auth';
import { cn, formatDateTime, formatTime, uuid } from '../../lib/utils';
import { useStore } from '../../store';
import { describeEvent, useAlerts } from '../../store/alerts';
import { Button, IconButton } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';
import { Badge, EmptyState, LoadingState, menuClass, menuItemClass, PaneHeader, SectionTitle } from '../ui/misc';
import { toast } from '../ui/Toast';
import RuleDialog from './RuleDialog';

const SEVERITY_TONE: Record<AlertSeverity, 'info' | 'warn' | 'danger'> = { info: 'info', warning: 'warn', critical: 'danger' };

/** The word on the badge: the condition, where it says more than the severity. */
const STATE_LABEL: Partial<Record<AlertState, string>> = { stale: 'silent', rate: 'rate', level: 'level', stuck: 'stuck' };

/** How long an alert has been true, in words. */
function sinceText(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** The mutes offered, in minutes. */
const MUTES = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '8 hours', minutes: 480 },
  { label: '24 hours', minutes: 1440 },
];

function ActiveRow({
  alert,
  canWrite,
  onSelect,
  onAck,
}: {
  alert: Alert;
  canWrite: boolean;
  onSelect: (subject: string) => void;
  onAck: (a: Alert, acked: boolean) => void;
}) {
  const seen = !!alert.ackedAt;
  return (
    <div className={cn('list-row py-1.5 gap-2', (seen || alert.muted) && 'opacity-60')}>
      <button
        type="button"
        className="flex items-center gap-2 min-w-0 flex-1 text-left"
        onClick={() => onSelect(alert.subject)}
        title={`Show ${alert.subject}`}
      >
        <Badge tone={SEVERITY_TONE[alert.severity]}>{STATE_LABEL[alert.state] ?? alert.severity}</Badge>
        <span className="font-mono text-xs truncate flex-1">{alert.subject}</span>
        <span className="text-xs text-muted truncate max-w-[220px] hidden md:inline">{alert.ruleName}</span>
        {alert.preview && <span className="text-xs text-faint font-mono truncate max-w-[240px] hidden lg:inline">{alert.preview}</span>}
      </button>
      {alert.muted && (
        <Badge tone="neutral" title="The rule or a maintenance window keeps this out of the webhook, the mail and the toasts">
          muted
        </Badge>
      )}
      {seen && (
        <Badge tone="neutral" title={`Seen ${formatDateTime(alert.ackedAt as number)}`}>
          <Check size={11} /> {alert.ackedBy ? `seen by ${alert.ackedBy}` : 'seen'}
        </Badge>
      )}
      <span className="text-xs text-faint tabular-nums shrink-0">{sinceText(alert.since)}</span>
      {canWrite && (
        <IconButton label={seen ? 'Mark as not seen' : 'Mark as seen'} size="xs" onClick={() => onAck(alert, !seen)}>
          {seen ? <EyeOff size={12} /> : <Eye size={12} />}
        </IconButton>
      )}
    </div>
  );
}

/** Where a maintenance window stands against the clock. */
function windowPhase(w: MaintenanceWindow, now = Date.now()): 'upcoming' | 'active' | 'over' {
  if (now < w.from) return 'upcoming';
  if (now >= w.to) return 'over';
  return 'active';
}

// Seconds and all, and in local time: a window typed by hand is a wall
// clock time, not a UTC one.
const toLocalInput = (ms: number) => new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function MaintenanceForm({ onSave, onCancel }: { onSave: (w: MaintenanceWindow) => Promise<void>; onCancel: () => void }) {
  const start = Date.now();
  const [name, setName] = useState('');
  const [from, setFrom] = useState(toLocalInput(start));
  const [to, setTo] = useState(toLocalInput(start + 2 * 3600_000));
  const [patterns, setPatterns] = useState('');
  const [busy, setBusy] = useState(false);
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const ok = name.trim() && Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs;
  return (
    <div className="card p-3 flex flex-col gap-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Name">
          <Input value={name} onChange={e => setName(e.target.value)} placeholder="Line 1 rebuild" autoFocus />
        </Field>
        <Field label="From">
          <Input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} />
        </Field>
      </div>
      <Field label="Subjects" hint="Patterns, comma separated; empty covers every subject.">
        <Input mono value={patterns} onChange={e => setPatterns(e.target.value)} placeholder="plant.line1.>, plant.line2.>" spellCheck={false} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!ok}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave({
                id: uuid(),
                name: name.trim(),
                from: fromMs,
                to: toMs,
                patterns: patterns
                  .split(/[,\s]+/)
                  .map(p => p.trim())
                  .filter(Boolean),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          Add window
        </Button>
      </div>
    </div>
  );
}

/**
 * The alerts module: what is true right now, the rules that decide it, the
 * planned silences, and the log of state changes. Rules are evaluated in
 * the backend, so they keep working while no browser is open.
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
  const ack = useAlerts(s => s.ack);
  const mute = useAlerts(s => s.mute);
  const maintenance = useAlerts(s => s.maintenance);
  const loadMaintenance = useAlerts(s => s.loadMaintenance);
  const saveMaintenance = useAlerts(s => s.saveMaintenance);
  const revealSubject = useStore(s => s.revealSubject);
  const setModule = useStore(s => s.setModule);
  const canWrite = useCanWrite();
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [addingWindow, setAddingWindow] = useState(false);

  useEffect(() => {
    void load();
    void loadMaintenance();
  }, [load, loadMaintenance]);

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

  const onAck = async (a: Alert, acked: boolean) => {
    try {
      await ack(a.key, acked);
    } catch (err) {
      toast.error('Could not mark the alert', errorMessage(err));
    }
  };

  const setMute = async (rule: AlertRule, minutes: number | null) => {
    try {
      await mute(rule, minutes ? Date.now() + minutes * 60_000 : null);
    } catch (err) {
      toast.error('Could not change the rule', errorMessage(err));
    }
  };

  const addWindow = async (w: MaintenanceWindow) => {
    try {
      await saveMaintenance([...maintenance, w]);
      setAddingWindow(false);
    } catch (err) {
      toast.error('Could not save the window', errorMessage(err));
    }
  };

  const removeWindow = async (w: MaintenanceWindow) => {
    try {
      await saveMaintenance(maintenance.filter(m => m.id !== w.id));
    } catch (err) {
      toast.error('Could not remove the window', errorMessage(err));
    }
  };

  const now = Date.now();

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
                  <ActiveRow key={a.key} alert={a} canWrite={canWrite} onSelect={onSelect} onAck={onAck} />
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
                description="A rule watches a subject pattern for an expression that holds, for silence, for too few or too many messages, for a threshold over a window, or for a value that stopped changing."
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
                      const muted = describeMute(r, now);
                      return (
                        <tr key={r.id} className={cn(!r.enabled && 'opacity-50')}>
                          <td className="max-w-[220px]">
                            <span className="truncate">{r.name || <span className="text-faint">unnamed</span>}</span>
                            {muted && (
                              <Badge tone="neutral" className="ml-1.5">
                                {muted}
                              </Badge>
                            )}
                          </td>
                          <td className="font-mono text-muted">{r.pattern}</td>
                          <td className="font-mono text-xs text-muted max-w-[320px] truncate" title={describeRule(r)}>
                            {describeRule(r) || '–'}
                          </td>
                          <td>
                            <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
                          </td>
                          <td className="num">{firing || <span className="text-faint">0</span>}</td>
                          <td className="whitespace-nowrap text-right">
                            {canWrite && (
                              <>
                                <DropdownMenu.Root>
                                  <DropdownMenu.Trigger asChild>
                                    <IconButton label={muted ? 'Change the mute' : 'Mute rule'} size="xs" active={!!muted}>
                                      <BellOff size={12} />
                                    </IconButton>
                                  </DropdownMenu.Trigger>
                                  <DropdownMenu.Portal>
                                    <DropdownMenu.Content className={menuClass} align="end" sideOffset={4}>
                                      {MUTES.map(m => (
                                        <DropdownMenu.Item key={m.minutes} className={menuItemClass} onSelect={() => setMute(r, m.minutes)}>
                                          Mute for {m.label}
                                        </DropdownMenu.Item>
                                      ))}
                                      {muted && (
                                        <DropdownMenu.Item className={menuItemClass} onSelect={() => setMute(r, null)}>
                                          Unmute
                                        </DropdownMenu.Item>
                                      )}
                                    </DropdownMenu.Content>
                                  </DropdownMenu.Portal>
                                </DropdownMenu.Root>
                                <IconButton label={r.enabled ? 'Disable rule' : 'Enable rule'} size="xs" onClick={() => toggleEnabled(r)}>
                                  {r.enabled ? <Bell size={12} /> : <BellOff size={12} className="text-faint" />}
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

          {/* A rebuild, a firmware update, a line that is down on purpose:
              the alerts of that time are noise, and the ones still true when
              it ends are the ones that matter. */}
          <div>
            <SectionTitle
              actions={
                canWrite &&
                !addingWindow && (
                  <Button size="xs" icon={<Plus size={12} />} onClick={() => setAddingWindow(true)}>
                    New window
                  </Button>
                )
              }
            >
              Maintenance
            </SectionTitle>
            {addingWindow && <MaintenanceForm onSave={addWindow} onCancel={() => setAddingWindow(false)} />}
            {maintenance.length === 0 ? (
              !addingWindow && (
                <div className="card px-3 py-4 text-sm text-muted flex items-center gap-2">
                  <Wrench size={14} className="text-faint" />
                  No planned silence. In a maintenance window alerts are logged but not sent; what is still true when it ends is sent then.
                </div>
              )
            ) : (
              <div className={cn('card divide-y divide-line/70', addingWindow && 'mt-3')}>
                {maintenance.map(w => {
                  const phase = windowPhase(w, now);
                  return (
                    <div key={w.id} className={cn('flex items-center gap-2 px-3 py-1.5 text-sm', phase === 'over' && 'opacity-50')}>
                      <Badge tone={phase === 'active' ? 'warn' : 'neutral'}>{phase}</Badge>
                      <span className="truncate">{w.name}</span>
                      <span className="text-xs text-faint tabular-nums shrink-0">
                        {formatDateTime(w.from)} – {formatDateTime(w.to)}
                      </span>
                      <span className="font-mono text-xs text-muted truncate ml-auto">{w.patterns?.length ? w.patterns.join(', ') : 'every subject'}</span>
                      {canWrite && (
                        <IconButton label="Remove window" size="xs" onClick={() => removeWindow(w)}>
                          <Trash2 size={12} className="text-danger" />
                        </IconButton>
                      )}
                    </div>
                  );
                })}
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
                    <Badge tone={e.state === 'resolved' ? 'ok' : SEVERITY_TONE[e.severity]}>{STATE_LABEL[e.state] ?? e.state}</Badge>
                    <span className="truncate">{describeEvent(e)}</span>
                    {e.muted && (
                      <Badge tone="neutral" title="Logged, not sent">
                        muted
                      </Badge>
                    )}
                    {e.webhookError && <span className="text-xs text-danger ml-auto shrink-0">{e.webhookError}</span>}
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
