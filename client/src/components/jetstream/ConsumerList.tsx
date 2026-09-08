import { Fragment, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, RefreshCw, TrendingUp, Trash2, Users } from 'lucide-react';
import type { AckPolicy, ConsumerInfo, DeliverPolicy, ReplayPolicy } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { cn, formatDateTime, formatDurationNs, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Field, Input, Select } from '../ui/Input';
import { confirm, Dialog } from '../ui/Dialog';
import { Badge, EmptyState, ErrorState, KeyValueGrid, LoadingState } from '../ui/misc';
import { toast } from '../ui/Toast';
import { useCanWrite } from '../../lib/auth';
import { RateChart } from '../ui/RateChart';
import { consumerSamples, consumerSeries, lagOf, pendingTrend, recordConsumer } from './consumerHistory';

export default function ConsumerList({
  connId,
  stream,
  streamLastSeq,
  onChanged,
}: {
  connId: string;
  stream: string;
  /** last sequence of the stream, for the lag column */
  streamLastSeq?: number;
  onChanged: () => void;
}) {
  const canWrite = useCanWrite();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ConsumerInfo | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, initial, reload } = useAsync<ConsumerInfo[]>(() => api.listConsumers(connId, stream), [connId, stream], {
    key: `consumers:${connId}:${stream}`,
    interval: 5000,
  });

  const del = async (name: string) => {
    if (
      !(await confirm({
        title: `Delete consumer ${name}?`,
        message: 'Clients using this consumer will stop receiving messages.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteConsumer(connId, stream, name);
      reload();
      onChanged();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const consumers = data ?? [];
  // Every load is a sample, so the charts fill while the list refreshes.
  useEffect(() => {
    for (const c of consumers) recordConsumer(connId, stream, c);
  }, [consumers, connId, stream]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="text-xs text-muted">
          {consumers.length} consumer{consumers.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Refresh" size="xs" loading={loading && !initial} onClick={reload}>
            <RefreshCw size={13} />
          </IconButton>
          {canWrite && (
            <Button size="xs" icon={<Plus size={12} />} onClick={() => setCreating(true)}>
              New consumer
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot list consumers" message={error} />
        ) : consumers.length === 0 ? (
          <EmptyState compact icon={Users} title="No consumers" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th className="w-8" />
                <th>Name</th>
                <th>Mode</th>
                <th>Deliver</th>
                <th>Ack</th>
                <th>Filter</th>
                <th className="num">Pending</th>
                <th className="num">Lag</th>
                <th className="num">Ack pending</th>
                <th className="num">Redelivered</th>
                <th className="num">Waiting</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {consumers.map(c => {
                const isOpen = open === c.name;
                const filter = c.config.filterSubject ?? c.config.filterSubjects?.join(', ');
                const lag = lagOf(c, streamLastSeq);
                const samples = consumerSamples(connId, stream, c.name);
                const trend = pendingTrend(samples);
                return (
                  <Fragment key={c.name}>
                    <tr className="cursor-pointer" onClick={() => setOpen(isOpen ? null : c.name)}>
                      <td className="text-faint">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                      <td className="font-medium font-mono">{c.name}</td>
                      <td>
                        <Badge tone={c.push ? 'info' : 'neutral'}>{c.push ? 'push' : 'pull'}</Badge>
                      </td>
                      <td className="text-muted">{c.config.deliverPolicy}</td>
                      <td className="text-muted">{c.config.ackPolicy}</td>
                      <td className="font-mono text-muted max-w-[220px] truncate">{filter || <span className="text-faint">all</span>}</td>
                      <td className="num">{formatNumber(c.numPending)}</td>
                      <td
                        className={cn('num', lag !== null && lag > 0 && trend === 'up' && 'text-warn')}
                        title={trend === 'up' ? 'The backlog grew over the last samples' : undefined}
                      >
                        {lag === null ? <span className="text-faint">–</span> : formatNumber(lag)}
                        {trend === 'up' && <TrendingUp size={11} className="inline ml-1 text-warn" />}
                      </td>
                      <td className={`num ${c.numAckPending > 0 ? 'text-warn' : ''}`}>{formatNumber(c.numAckPending)}</td>
                      <td className={`num ${c.numRedelivered > 0 ? 'text-warn' : ''}`}>{formatNumber(c.numRedelivered)}</td>
                      <td className="num">{formatNumber(c.numWaiting)}</td>
                      <td className="whitespace-nowrap">
                        {canWrite && (
                          <>
                            <IconButton
                              label="Edit consumer"
                              size="xs"
                              onClick={e => {
                                e.stopPropagation();
                                setEditing(c);
                              }}
                            >
                              <Pencil size={12} />
                            </IconButton>
                            <IconButton
                              label="Delete consumer"
                              size="xs"
                              onClick={e => {
                                e.stopPropagation();
                                del(c.name);
                              }}
                            >
                              <Trash2 size={12} className="text-danger" />
                            </IconButton>
                          </>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={12} className="whitespace-normal! bg-panel/60 py-3!">
                          <KeyValueGrid
                            columns={3}
                            items={[
                              { label: 'Created', value: formatDateTime(c.created) },
                              { label: 'Description', value: c.description || '–' },
                              { label: 'Durable', value: c.config.durableName || '–', mono: true },
                              {
                                label: 'Delivered (stream / consumer)',
                                value: `${formatNumber(c.delivered.streamSeq)} / ${formatNumber(c.delivered.consumerSeq)}`,
                                mono: true,
                              },
                              {
                                label: 'Ack floor (stream / consumer)',
                                value: `${formatNumber(c.ackFloor.streamSeq)} / ${formatNumber(c.ackFloor.consumerSeq)}`,
                                mono: true,
                              },
                              { label: 'Ack wait', value: formatDurationNs(c.config.ackWait) },
                              { label: 'Max deliver', value: c.config.maxDeliver <= 0 ? 'unlimited' : c.config.maxDeliver },
                              { label: 'Max ack pending', value: formatNumber(c.config.maxAckPending) },
                              { label: 'Replay', value: c.config.replayPolicy },
                              ...(c.config.deliverSubject ? [{ label: 'Deliver subject', value: c.config.deliverSubject, mono: true }] : []),
                              ...(c.config.optStartSeq ? [{ label: 'Start sequence', value: c.config.optStartSeq }] : []),
                            ]}
                          />

                          {samples.length > 1 && (
                            <div className="mt-3 max-w-[560px]">
                              <RateChart
                                title="Backlog"
                                height={110}
                                times={consumerSeries(samples, x => x.pending).times}
                                series={[
                                  { label: 'pending', color: 'rgb(var(--accent))', values: consumerSeries(samples, x => x.pending).values },
                                  { label: 'ack pending', color: 'rgb(var(--warn))', values: consumerSeries(samples, x => x.ackPending).values },
                                ]}
                                format={v => formatNumber(Math.round(v))}
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {creating && (
        <ConsumerDialog
          connId={connId}
          stream={stream}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
            onChanged();
          }}
        />
      )}
      {editing && (
        <ConsumerDialog
          connId={connId}
          stream={stream}
          existing={editing}
          onClose={() => setEditing(null)}
          onCreated={() => {
            setEditing(null);
            reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** Creates a consumer, or with `existing` edits the fields JetStream allows to change. */
function ConsumerDialog({
  connId,
  stream,
  existing,
  onClose,
  onCreated,
}: {
  connId: string;
  stream: string;
  existing?: ConsumerInfo;
  onClose: () => void;
  onCreated: () => void;
}) {
  const cfg = existing?.config;
  const fixed = !!existing; // name and policies cannot change after creation
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(cfg?.description ?? '');
  const [filter, setFilter] = useState(cfg?.filterSubject ?? cfg?.filterSubjects?.join(', ') ?? '');
  const [deliver, setDeliver] = useState<DeliverPolicy>((cfg?.deliverPolicy as DeliverPolicy) ?? 'all');
  const [startSeq, setStartSeq] = useState(cfg?.optStartSeq ? String(cfg.optStartSeq) : '');
  const [ack, setAck] = useState<AckPolicy>((cfg?.ackPolicy as AckPolicy) ?? 'explicit');
  const [ackWait, setAckWait] = useState(cfg?.ackWait ? String(Math.round(cfg.ackWait / 1e9)) : '30');
  const [maxDeliver, setMaxDeliver] = useState(cfg && cfg.maxDeliver > 0 ? String(cfg.maxDeliver) : '');
  const [maxAckPending, setMaxAckPending] = useState(cfg?.maxAckPending ? String(cfg.maxAckPending) : '');
  const [replay, setReplay] = useState<ReplayPolicy>((cfg?.replayPolicy as ReplayPolicy) ?? 'instant');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api.updateConsumer(connId, stream, existing.name, {
          description,
          filterSubject: filter.trim(),
          ackWait: Number(ackWait) > 0 ? Number(ackWait) * 1e9 : undefined,
          maxDeliver: Number(maxDeliver) > 0 ? Number(maxDeliver) : -1,
          maxAckPending: Number(maxAckPending) > 0 ? Number(maxAckPending) : 0,
        });
        onCreated();
        return;
      }
      await api.createConsumer(connId, stream, {
        durableName: name.trim(),
        description: description || undefined,
        filterSubject: filter.trim() || undefined,
        deliverPolicy: deliver,
        optStartSeq: deliver === 'by_start_sequence' ? Number(startSeq) || undefined : undefined,
        ackPolicy: ack,
        ackWait: Number(ackWait) > 0 ? Number(ackWait) * 1e9 : undefined,
        maxDeliver: Number(maxDeliver) > 0 ? Number(maxDeliver) : undefined,
        maxAckPending: Number(maxAckPending) > 0 ? Number(maxAckPending) : undefined,
        replayPolicy: replay,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title={existing ? `Edit consumer ${existing.name}` : `New consumer on ${stream}`}
      description={existing ? 'Name, deliver policy, ack policy and replay are fixed once a consumer exists.' : 'Creates a durable pull consumer.'}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger font-mono truncate">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            {existing ? 'Save' : 'Create consumer'}
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" required>
          <Input mono value={name} onChange={e => setName(e.target.value)} placeholder="order-processor" autoFocus={!fixed} disabled={fixed} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <Field label="Filter subject" hint="Only messages matching this subject are delivered." className="md:col-span-2">
          <Input mono value={filter} onChange={e => setFilter(e.target.value)} placeholder="orders.eu.>" />
        </Field>
        <Field label="Deliver policy">
          <Select value={deliver} onChange={e => setDeliver(e.target.value as DeliverPolicy)} disabled={fixed}>
            <option value="all">All</option>
            <option value="last">Last</option>
            <option value="new">New</option>
            <option value="last_per_subject">Last per subject</option>
            <option value="by_start_sequence">By start sequence</option>
          </Select>
        </Field>
        {deliver === 'by_start_sequence' ? (
          <Field label="Start sequence">
            <Input type="number" min={1} value={startSeq} onChange={e => setStartSeq(e.target.value)} disabled={fixed} />
          </Field>
        ) : (
          <Field label="Replay policy">
            <Select value={replay} onChange={e => setReplay(e.target.value as ReplayPolicy)} disabled={fixed}>
              <option value="instant">Instant</option>
              <option value="original">Original timing</option>
            </Select>
          </Field>
        )}
        <Field label="Ack policy">
          <Select value={ack} onChange={e => setAck(e.target.value as AckPolicy)} disabled={fixed}>
            <option value="explicit">Explicit</option>
            <option value="all">All</option>
            <option value="none">None</option>
          </Select>
        </Field>
        <Field label="Ack wait (seconds)">
          <Input type="number" min={1} value={ackWait} onChange={e => setAckWait(e.target.value)} />
        </Field>
        <Field label="Max deliver" hint="Empty = unlimited">
          <Input type="number" min={1} value={maxDeliver} onChange={e => setMaxDeliver(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Max ack pending" hint="Empty = server default">
          <Input type="number" min={1} value={maxAckPending} onChange={e => setMaxAckPending(e.target.value)} placeholder="default" />
        </Field>
      </form>
    </Dialog>
  );
}
