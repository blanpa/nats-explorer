import { useState } from 'react';
import type { DiscardPolicy, RetentionPolicy, StorageType, StreamConfigInput, StreamInfo } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { parseList } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '../ui/Input';
import { Dialog } from '../ui/Dialog';

const UNITS: { id: string; label: string; ns: number }[] = [
  { id: 's', label: 'seconds', ns: 1e9 },
  { id: 'm', label: 'minutes', ns: 60e9 },
  { id: 'h', label: 'hours', ns: 3600e9 },
  { id: 'd', label: 'days', ns: 86400e9 },
];

function splitDuration(ns: number): { value: string; unit: string } {
  if (!ns || ns <= 0) return { value: '', unit: 'h' };
  for (const u of [...UNITS].reverse()) {
    if (ns % u.ns === 0) return { value: String(ns / u.ns), unit: u.id };
  }
  return { value: String(ns / 1e9), unit: 's' };
}

function toNs(value: string, unit: string): number {
  const n = Number(value);
  if (!value.trim() || !Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * (UNITS.find(u => u.id === unit)?.ns ?? 1e9));
}

const numOrUnlimited = (s: string): number => {
  const n = Number(s);
  return s.trim() === '' || !Number.isFinite(n) || n < 0 ? -1 : Math.floor(n);
};

interface Props {
  connId: string;
  existing?: StreamInfo;
  onClose: () => void;
  onSaved: (info: StreamInfo) => void;
}

export default function StreamDialog({ connId, existing, onClose, onSaved }: Props) {
  const edit = !!existing;
  const age = splitDuration(existing?.maxAge ?? 0);
  const dup = splitDuration(existing?.duplicateWindow ?? 0);

  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [subjects, setSubjects] = useState(existing?.subjects.join(', ') ?? '');
  const [retention, setRetention] = useState<RetentionPolicy>((existing?.retention.toLowerCase() as RetentionPolicy) ?? 'limits');
  const [storage, setStorage] = useState<StorageType>((existing?.storage.toLowerCase() as StorageType) ?? 'file');
  const [discard, setDiscard] = useState<DiscardPolicy>((existing?.discard.toLowerCase() as DiscardPolicy) ?? 'old');
  const [replicas, setReplicas] = useState(String(existing?.replicas ?? 1));
  const [maxMsgs, setMaxMsgs] = useState(existing && existing.maxMsgs >= 0 ? String(existing.maxMsgs) : '');
  const [maxMsgsPerSubject, setMaxMsgsPerSubject] = useState(existing && existing.maxMsgsPerSubject >= 0 ? String(existing.maxMsgsPerSubject) : '');
  const [maxBytes, setMaxBytes] = useState(existing && existing.maxBytes >= 0 ? String(existing.maxBytes) : '');
  const [maxMsgSize, setMaxMsgSize] = useState(existing && existing.maxMsgSize >= 0 ? String(existing.maxMsgSize) : '');
  const [maxAge, setMaxAge] = useState(age.value);
  const [maxAgeUnit, setMaxAgeUnit] = useState(age.unit);
  const [dupWindow, setDupWindow] = useState(dup.value);
  const [dupUnit, setDupUnit] = useState(dup.unit);
  const [flags, setFlags] = useState({
    denyDelete: existing?.denyDelete ?? false,
    denyPurge: existing?.denyPurge ?? false,
    allowRollup: existing?.allowRollup ?? false,
    allowDirect: existing?.allowDirect ?? false,
    noAck: existing?.noAck ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjectList = parseList(subjects);
  const valid = name.trim().length > 0 && subjectList.length > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const cfg: StreamConfigInput = {
      name: name.trim(),
      description,
      subjects: subjectList,
      retention,
      storage,
      discard,
      replicas: Math.max(1, Number(replicas) || 1),
      maxMsgs: numOrUnlimited(maxMsgs),
      maxMsgsPerSubject: numOrUnlimited(maxMsgsPerSubject),
      maxBytes: numOrUnlimited(maxBytes),
      maxMsgSize: numOrUnlimited(maxMsgSize),
      maxAge: toNs(maxAge, maxAgeUnit),
      duplicateWindow: toNs(dupWindow, dupUnit),
      ...flags,
    };
    try {
      const info = edit ? await api.updateStream(connId, existing!.name, cfg) : await api.createStream(connId, cfg);
      onSaved(info);
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
      title={edit ? `Edit stream ${existing!.name}` : 'Create stream'}
      description={
        edit ? 'Storage, retention and name cannot be changed after creation.' : 'Messages published to the listed subjects are persisted in this stream.'
      }
      width="lg"
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger font-mono truncate">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            {edit ? 'Save changes' : 'Create stream'}
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
          <Input value={name} onChange={e => setName(e.target.value)} disabled={edit} placeholder="ORDERS" autoFocus={!edit} mono />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <Field label="Subjects" hint="Comma separated. Wildcards * and > are allowed." required className="md:col-span-2">
          <Textarea rows={2} value={subjects} onChange={e => setSubjects(e.target.value)} placeholder="orders.>, invoices.*.created" />
        </Field>

        <Field label="Retention">
          <Select value={retention} onChange={e => setRetention(e.target.value as RetentionPolicy)} disabled={edit}>
            <option value="limits">Limits</option>
            <option value="interest">Interest</option>
            <option value="workqueue">Work queue</option>
          </Select>
        </Field>
        <Field label="Storage">
          <Select value={storage} onChange={e => setStorage(e.target.value as StorageType)} disabled={edit}>
            <option value="file">File</option>
            <option value="memory">Memory</option>
          </Select>
        </Field>
        <Field label="Discard policy">
          <Select value={discard} onChange={e => setDiscard(e.target.value as DiscardPolicy)}>
            <option value="old">Old (drop oldest when full)</option>
            <option value="new">New (reject new when full)</option>
          </Select>
        </Field>
        <Field label="Replicas">
          <Input type="number" min={1} max={5} value={replicas} onChange={e => setReplicas(e.target.value)} />
        </Field>

        <Field label="Max messages" hint="Empty = unlimited">
          <Input type="number" min={0} value={maxMsgs} onChange={e => setMaxMsgs(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Max messages per subject" hint="Empty = unlimited">
          <Input type="number" min={0} value={maxMsgsPerSubject} onChange={e => setMaxMsgsPerSubject(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Max bytes" hint="Empty = unlimited">
          <Input type="number" min={0} value={maxBytes} onChange={e => setMaxBytes(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Max message size (bytes)" hint="Empty = unlimited">
          <Input type="number" min={0} value={maxMsgSize} onChange={e => setMaxMsgSize(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Max age" hint="Empty = keep forever">
          <div className="flex gap-2">
            <Input type="number" min={0} value={maxAge} onChange={e => setMaxAge(e.target.value)} placeholder="unlimited" />
            <Select className="w-32" value={maxAgeUnit} onChange={e => setMaxAgeUnit(e.target.value)}>
              {UNITS.map(u => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label="Duplicate window" hint="De-duplication window for Nats-Msg-Id">
          <div className="flex gap-2">
            <Input type="number" min={0} value={dupWindow} onChange={e => setDupWindow(e.target.value)} placeholder="default" />
            <Select className="w-32" value={dupUnit} onChange={e => setDupUnit(e.target.value)}>
              {UNITS.map(u => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </Select>
          </div>
        </Field>

        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
          <Checkbox
            label="Allow direct get"
            description="Serve GetMsg requests directly from replicas."
            checked={flags.allowDirect}
            onChange={e => setFlags(f => ({ ...f, allowDirect: e.target.checked }))}
          />
          <Checkbox
            label="Allow roll-ups"
            description="Permit Nats-Rollup headers to replace history."
            checked={flags.allowRollup}
            onChange={e => setFlags(f => ({ ...f, allowRollup: e.target.checked }))}
          />
          <Checkbox
            label="Deny delete"
            description="Disallow deleting individual messages."
            checked={flags.denyDelete}
            onChange={e => setFlags(f => ({ ...f, denyDelete: e.target.checked }))}
          />
          <Checkbox
            label="Deny purge"
            description="Disallow purging the stream."
            checked={flags.denyPurge}
            onChange={e => setFlags(f => ({ ...f, denyPurge: e.target.checked }))}
          />
          <Checkbox
            label="No ack"
            description="Do not acknowledge publishes (fire and forget)."
            checked={flags.noAck}
            onChange={e => setFlags(f => ({ ...f, noAck: e.target.checked }))}
          />
        </div>
      </form>
    </Dialog>
  );
}
