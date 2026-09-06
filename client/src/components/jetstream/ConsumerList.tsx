import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import type { AckPolicy, ConsumerInfo, DeliverPolicy, ReplayPolicy } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatDateTime, formatDurationNs, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Field, Input, Select } from '../ui/Input';
import { confirm, Dialog } from '../ui/Dialog';
import { Badge, EmptyState, ErrorState, KeyValueGrid, LoadingState } from '../ui/misc';
import { toast } from '../ui/Toast';

export default function ConsumerList({ connId, stream, onChanged }: { connId: string; stream: string; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, initial, reload } = useAsync<ConsumerInfo[]>(() => api.listConsumers(connId, stream), [connId, stream], { key: `consumers:${connId}:${stream}`, interval: 5000 });

  const del = async (name: string) => {
    if (!(await confirm({ title: `Delete consumer ${name}?`, message: 'Clients using this consumer will stop receiving messages.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deleteConsumer(connId, stream, name);
      reload();
      onChanged();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const consumers = data ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="text-xs text-muted">{consumers.length} consumer{consumers.length === 1 ? '' : 's'}</span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Refresh" size="xs" loading={loading && !initial} onClick={reload}>
            <RefreshCw size={13} />
          </IconButton>
          <Button size="xs" icon={<Plus size={12} />} onClick={() => setCreating(true)}>
            New consumer
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot list consumers" message={error} />
        ) : consumers.length === 0 ? (
          <EmptyState compact icon={Users} title="No consumers" description="Create a durable consumer to read from this stream." />
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
                <th className="num">Ack pending</th>
                <th className="num">Redelivered</th>
                <th className="num">Waiting</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {consumers.map(c => {
                const isOpen = open === c.name;
                const filter = c.config.filterSubject ?? c.config.filterSubjects?.join(', ');
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
                      <td className={`num ${c.numAckPending > 0 ? 'text-warn' : ''}`}>{formatNumber(c.numAckPending)}</td>
                      <td className={`num ${c.numRedelivered > 0 ? 'text-warn' : ''}`}>{formatNumber(c.numRedelivered)}</td>
                      <td className="num">{formatNumber(c.numWaiting)}</td>
                      <td>
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
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={11} className="!whitespace-normal bg-panel/60 !py-3">
                          <KeyValueGrid
                            columns={3}
                            items={[
                              { label: 'Created', value: formatDateTime(c.created) },
                              { label: 'Description', value: c.description || '–' },
                              { label: 'Durable', value: c.config.durableName || '–', mono: true },
                              { label: 'Delivered (stream / consumer)', value: `${formatNumber(c.delivered.streamSeq)} / ${formatNumber(c.delivered.consumerSeq)}`, mono: true },
                              { label: 'Ack floor (stream / consumer)', value: `${formatNumber(c.ackFloor.streamSeq)} / ${formatNumber(c.ackFloor.consumerSeq)}`, mono: true },
                              { label: 'Ack wait', value: formatDurationNs(c.config.ackWait) },
                              { label: 'Max deliver', value: c.config.maxDeliver <= 0 ? 'unlimited' : c.config.maxDeliver },
                              { label: 'Max ack pending', value: formatNumber(c.config.maxAckPending) },
                              { label: 'Replay', value: c.config.replayPolicy },
                              ...(c.config.deliverSubject ? [{ label: 'Deliver subject', value: c.config.deliverSubject, mono: true }] : []),
                              ...(c.config.optStartSeq ? [{ label: 'Start sequence', value: c.config.optStartSeq }] : []),
                            ]}
                          />
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
    </div>
  );
}

function ConsumerDialog({ connId, stream, onClose, onCreated }: { connId: string; stream: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [filter, setFilter] = useState('');
  const [deliver, setDeliver] = useState<DeliverPolicy>('all');
  const [startSeq, setStartSeq] = useState('');
  const [ack, setAck] = useState<AckPolicy>('explicit');
  const [ackWait, setAckWait] = useState('30');
  const [maxDeliver, setMaxDeliver] = useState('');
  const [maxAckPending, setMaxAckPending] = useState('');
  const [replay, setReplay] = useState<ReplayPolicy>('instant');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
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
      title={`New consumer on ${stream}`}
      description="Creates a durable pull consumer."
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger font-mono truncate">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            Create consumer
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
          <Input mono value={name} onChange={e => setName(e.target.value)} placeholder="order-processor" autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <Field label="Filter subject" hint="Only messages matching this subject are delivered." className="md:col-span-2">
          <Input mono value={filter} onChange={e => setFilter(e.target.value)} placeholder="orders.eu.>" />
        </Field>
        <Field label="Deliver policy">
          <Select value={deliver} onChange={e => setDeliver(e.target.value as DeliverPolicy)}>
            <option value="all">All</option>
            <option value="last">Last</option>
            <option value="new">New</option>
            <option value="last_per_subject">Last per subject</option>
            <option value="by_start_sequence">By start sequence</option>
          </Select>
        </Field>
        {deliver === 'by_start_sequence' ? (
          <Field label="Start sequence">
            <Input type="number" min={1} value={startSeq} onChange={e => setStartSeq(e.target.value)} />
          </Field>
        ) : (
          <Field label="Replay policy">
            <Select value={replay} onChange={e => setReplay(e.target.value as ReplayPolicy)}>
              <option value="instant">Instant</option>
              <option value="original">Original timing</option>
            </Select>
          </Field>
        )}
        <Field label="Ack policy">
          <Select value={ack} onChange={e => setAck(e.target.value as AckPolicy)}>
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
