import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { DiscardPolicy, RetentionPolicy, StorageType, StreamCompression, StreamConfigInput, StreamInfo, StreamPersistMode } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { formatMetadata, parseMetadata, type SourceDraft, sourceDraft, sourceFromDraft } from '../../lib/streamForm';
import { parseList } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '../ui/Input';
import { Dialog } from '../ui/Dialog';
import { SectionTitle } from '../ui/misc';

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

const numOrZero = (s: string): number => {
  const n = Number(s);
  return s.trim() === '' || !Number.isFinite(n) || n < 0 ? 0 : Math.floor(n);
};

function DurationInput({
  value,
  unit,
  onValue,
  onUnit,
  placeholder,
}: {
  value: string;
  unit: string;
  onValue: (v: string) => void;
  onUnit: (u: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex gap-2">
      <Input type="number" min={0} value={value} onChange={e => onValue(e.target.value)} placeholder={placeholder} />
      <Select className="w-32" value={unit} onChange={e => onUnit(e.target.value)}>
        {UNITS.map(u => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

interface Props {
  connId: string;
  existing?: StreamInfo;
  /** the existing stream is a starting point for a new one, not the one being edited */
  duplicate?: boolean;
  onClose: () => void;
  onSaved: (info: StreamInfo) => void;
}

/**
 * Create or edit a stream, with every part of its configuration: the
 * limits, the switches, where it is placed and how it is stored, what it
 * mirrors or sources, what it republishes and how subjects are rewritten,
 * and the metadata. What cannot change after creation is disabled, not
 * hidden, so an edit still shows the whole picture.
 */
export default function StreamDialog({ connId, existing, duplicate, onClose, onSaved }: Props) {
  const edit = !!existing && !duplicate;
  const age = splitDuration(existing?.maxAge ?? 0);
  const dup = splitDuration(existing?.duplicateWindow ?? 0);
  const marker = splitDuration(existing?.subjectDeleteMarkerTtl ?? 0);
  const inactive = splitDuration(existing?.consumerLimits?.inactiveThreshold ?? 0);

  const [name, setName] = useState(duplicate ? '' : (existing?.name ?? ''));
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
  const [maxConsumers, setMaxConsumers] = useState(existing && existing.maxConsumers >= 0 ? String(existing.maxConsumers) : '');
  const [maxAge, setMaxAge] = useState(age.value);
  const [maxAgeUnit, setMaxAgeUnit] = useState(age.unit);
  const [dupWindow, setDupWindow] = useState(dup.value);
  const [dupUnit, setDupUnit] = useState(dup.unit);
  const [markerTtl, setMarkerTtl] = useState(marker.value);
  const [markerUnit, setMarkerUnit] = useState(marker.unit);
  const [flags, setFlags] = useState({
    denyDelete: existing?.denyDelete ?? false,
    denyPurge: existing?.denyPurge ?? false,
    allowRollup: existing?.allowRollup ?? false,
    allowDirect: existing?.allowDirect ?? false,
    noAck: existing?.noAck ?? false,
    discardNewPerSubject: existing?.discardNewPerSubject ?? false,
    allowMsgTtl: existing?.allowMsgTtl ?? false,
    allowMsgCounter: existing?.allowMsgCounter ?? false,
    allowAtomicPublish: existing?.allowAtomicPublish ?? false,
    allowMsgSchedules: existing?.allowMsgSchedules ?? false,
    mirrorDirect: existing?.mirrorDirect ?? false,
  });
  const flag = (key: keyof typeof flags) => ({
    checked: flags[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setFlags(f => ({ ...f, [key]: e.target.checked })),
  });

  // Storage and placement.
  const [compression, setCompression] = useState<StreamCompression>(existing?.compression ?? 'none');
  const [persistMode, setPersistMode] = useState<StreamPersistMode>(existing?.persistMode ?? 'default');
  const [cluster, setCluster] = useState(existing?.placement?.cluster ?? '');
  const [tags, setTags] = useState(existing?.placement?.tags?.join(', ') ?? '');
  const [firstSeq, setFirstSeq] = useState('');

  // Replication. A mirror is decided at creation: a stream cannot become one later.
  const [mirror, setMirror] = useState<SourceDraft>(sourceDraft(existing?.mirror ?? undefined));
  const [sources, setSources] = useState<SourceDraft[]>((existing?.sources ?? []).map(s => sourceDraft(s)));
  const setSource = (i: number, patch: Partial<SourceDraft>) => setSources(list => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  // Republish and transform.
  const [rpSrc, setRpSrc] = useState(existing?.republish?.src ?? '');
  const [rpDest, setRpDest] = useState(existing?.republish?.dest ?? '');
  const [rpHeadersOnly, setRpHeadersOnly] = useState(existing?.republish?.headersOnly ?? false);
  const [stSrc, setStSrc] = useState(existing?.subjectTransform?.src ?? '');
  const [stDest, setStDest] = useState(existing?.subjectTransform?.dest ?? '');

  // Metadata and consumer limits.
  const [metadata, setMetadata] = useState(formatMetadata(existing?.metadata));
  const [inactiveThreshold, setInactiveThreshold] = useState(inactive.value);
  const [inactiveUnit, setInactiveUnit] = useState(inactive.unit);
  const [maxAckPending, setMaxAckPending] = useState(existing?.consumerLimits?.maxAckPending ? String(existing.consumerLimits.maxAckPending) : '');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subjectList = parseList(subjects);
  const mirrorCfg = sourceFromDraft(mirror);
  // A mirror has no subjects of its own; a sourcing stream may have none either.
  const valid = name.trim().length > 0 && (subjectList.length > 0 || !!mirrorCfg || sources.some(s => s.name.trim()));

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
      maxConsumers: numOrUnlimited(maxConsumers),
      maxAge: toNs(maxAge, maxAgeUnit),
      duplicateWindow: toNs(dupWindow, dupUnit),
      subjectDeleteMarkerTtl: toNs(markerTtl, markerUnit),
      ...flags,
      compression,
      persistMode,
      placement: cluster.trim() || parseList(tags).length ? { cluster: cluster.trim(), tags: parseList(tags) } : null,
      mirror: mirrorCfg,
      sources: sources.map(sourceFromDraft).filter((s): s is NonNullable<typeof s> => s !== null),
      republish: rpDest.trim() ? { src: rpSrc.trim(), dest: rpDest.trim(), headersOnly: rpHeadersOnly } : null,
      subjectTransform: stDest.trim() ? { src: stSrc.trim(), dest: stDest.trim() } : null,
      metadata: parseMetadata(metadata),
      consumerInactiveThreshold: toNs(inactiveThreshold, inactiveUnit),
      consumerMaxAckPending: numOrZero(maxAckPending),
    };
    if (!edit && firstSeq.trim()) cfg.firstSeq = numOrZero(firstSeq);
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
      title={edit ? `Edit stream ${existing!.name}` : duplicate ? `New stream like ${existing!.name}` : 'Create stream'}
      description={
        edit
          ? 'Storage, retention, name, a mirror and the first sequence cannot be changed after creation.'
          : 'Messages published to the listed subjects are persisted in this stream.'
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
        <Field label="Subjects" hint="Comma separated. Wildcards * and > are allowed. A mirror has none of its own." className="md:col-span-2">
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

        <SectionTitle className="md:col-span-2 mb-0">Limits</SectionTitle>
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
          <DurationInput value={maxAge} unit={maxAgeUnit} onValue={setMaxAge} onUnit={setMaxAgeUnit} placeholder="unlimited" />
        </Field>
        <Field label="Duplicate window" hint="De-duplication window for Nats-Msg-Id">
          <DurationInput value={dupWindow} unit={dupUnit} onValue={setDupWindow} onUnit={setDupUnit} placeholder="default" />
        </Field>
        <Field label="Max consumers" hint="Empty = unlimited">
          <Input type="number" min={0} value={maxConsumers} onChange={e => setMaxConsumers(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Subject delete marker" hint="How long a marker stays after a subject's last message is gone (NATS 2.11). Empty = none.">
          <DurationInput value={markerTtl} unit={markerUnit} onValue={setMarkerTtl} onUnit={setMarkerUnit} placeholder="none" />
        </Field>

        <SectionTitle className="md:col-span-2 mb-0">Switches</SectionTitle>
        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-2">
          <Checkbox label="Allow direct get" description="Serve GetMsg requests directly from replicas." {...flag('allowDirect')} />
          <Checkbox label="Allow roll-ups" description="Permit Nats-Rollup headers to replace history." {...flag('allowRollup')} />
          <Checkbox label="Deny delete" description="Disallow deleting individual messages." {...flag('denyDelete')} />
          <Checkbox label="Deny purge" description="Disallow purging the stream." {...flag('denyPurge')} />
          <Checkbox
            label="Discard new per subject"
            description="With the new discard policy, apply the limit per subject instead of to the whole stream. Needs a per-subject message limit."
            {...flag('discardNewPerSubject')}
          />
          <Checkbox
            label="Allow per-message TTL"
            description="Publishers may expire their own messages with a Nats-TTL header (NATS 2.11)."
            {...flag('allowMsgTtl')}
          />
          <Checkbox label="No ack" description="Do not acknowledge publishes (fire and forget)." {...flag('noAck')} />
          <Checkbox
            label="Mirror answers direct gets"
            description="A mirror serves GetMsg requests itself instead of the origin (mirror direct)."
            {...flag('mirrorDirect')}
          />
          <Checkbox label="Allow message counters" description="Nats-Incr headers turn a subject into a counter (NATS 2.12)." {...flag('allowMsgCounter')} />
          <Checkbox
            label="Allow atomic batch publish"
            description="A batch of messages is stored whole or not at all (NATS 2.12)."
            {...flag('allowAtomicPublish')}
          />
          <Checkbox
            label="Allow scheduled messages"
            description="A Nats-Schedule header publishes a message later (NATS 2.12)."
            {...flag('allowMsgSchedules')}
          />
        </div>

        <SectionTitle className="md:col-span-2 mb-0">Storage and placement</SectionTitle>
        <Field label="Compression" hint="S2 compresses the file store; costs CPU, saves disk.">
          <Select value={compression} onChange={e => setCompression(e.target.value as StreamCompression)}>
            <option value="none">None</option>
            <option value="s2">S2</option>
          </Select>
        </Field>
        <Field
          label="Persist mode"
          hint="Async acknowledges a publish before it is flushed to disk (NATS 2.12): faster, and a hard kill can lose what was not flushed yet."
        >
          <Select value={persistMode} onChange={e => setPersistMode(e.target.value as StreamPersistMode)}>
            <option value="default">Default (flush before the ack)</option>
            <option value="async">Async</option>
          </Select>
        </Field>
        <Field label="Placement: cluster" hint="The cluster that holds the stream; empty lets the meta leader choose.">
          <Input mono value={cluster} onChange={e => setCluster(e.target.value)} placeholder="east" />
        </Field>
        <Field label="Placement: server tags" hint="Comma separated; only servers carrying every tag hold the stream.">
          <Input mono value={tags} onChange={e => setTags(e.target.value)} placeholder="ssd, zone-a" />
        </Field>
        {!edit && (
          <Field label="First sequence" hint="Where the stream starts counting; empty starts at 1.">
            <Input type="number" min={1} value={firstSeq} onChange={e => setFirstSeq(e.target.value)} placeholder="1" />
          </Field>
        )}

        <SectionTitle className="md:col-span-2 mb-0">Replication</SectionTitle>
        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-4 gap-3">
          <Field label="Mirror of" hint="A copy of another stream; decided at creation.">
            <Input mono value={mirror.name} disabled={edit} onChange={e => setMirror(m => ({ ...m, name: e.target.value }))} placeholder="ORDERS" />
          </Field>
          <Field label="Mirror filter">
            <Input
              mono
              value={mirror.filterSubject}
              disabled={edit}
              onChange={e => setMirror(m => ({ ...m, filterSubject: e.target.value }))}
              placeholder="orders.eu.>"
            />
          </Field>
          <Field label="Mirror from seq">
            <Input type="number" min={1} value={mirror.optStartSeq} disabled={edit} onChange={e => setMirror(m => ({ ...m, optStartSeq: e.target.value }))} />
          </Field>
          <Field label="Mirror from time">
            <Input type="datetime-local" value={mirror.optStartTime} disabled={edit} onChange={e => setMirror(m => ({ ...m, optStartTime: e.target.value }))} />
          </Field>
        </div>
        <div className="md:col-span-2 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">Sources: streams this one copies messages from, each with an optional filter and start.</span>
            <Button size="xs" variant="outline" icon={<Plus size={12} />} onClick={() => setSources(list => [...list, sourceDraft()])}>
              Add source
            </Button>
          </div>
          {sources.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own while they are typed
            <div key={i} className="grid grid-cols-[1fr_1fr_100px_auto] gap-2 items-center">
              <Input mono value={s.name} onChange={e => setSource(i, { name: e.target.value })} placeholder="stream" aria-label={`Source ${i + 1} stream`} />
              <Input
                mono
                value={s.filterSubject}
                onChange={e => setSource(i, { filterSubject: e.target.value })}
                placeholder="filter subject"
                aria-label={`Source ${i + 1} filter`}
              />
              <Input
                type="number"
                min={1}
                value={s.optStartSeq}
                onChange={e => setSource(i, { optStartSeq: e.target.value })}
                placeholder="from seq"
                aria-label={`Source ${i + 1} start`}
              />
              <IconButton label="Remove source" size="sm" onClick={() => setSources(list => list.filter((_, j) => j !== i))}>
                <X size={13} />
              </IconButton>
            </div>
          ))}
        </div>

        <SectionTitle className="md:col-span-2 mb-0">Republish and transform</SectionTitle>
        <Field label="Republish from" hint="Subjects to republish as they are stored; empty means every subject of the stream.">
          <Input mono value={rpSrc} onChange={e => setRpSrc(e.target.value)} placeholder="orders.>" />
        </Field>
        <Field label="Republish to" hint="Empty turns republishing off. Wildcards carry over: orders.> to republished.orders.>">
          <Input mono value={rpDest} onChange={e => setRpDest(e.target.value)} placeholder="republished.orders.>" />
        </Field>
        <div className="md:col-span-2">
          <Checkbox
            label="Republish headers only"
            description="The republished message carries the headers and the size, not the payload."
            checked={rpHeadersOnly}
            onChange={e => setRpHeadersOnly(e.target.checked)}
          />
        </div>
        <Field label="Transform subjects from" hint="A mapping applied on the way in; empty means every subject.">
          <Input mono value={stSrc} onChange={e => setStSrc(e.target.value)} placeholder="orders.*.*" />
        </Field>
        <Field label="Transform subjects to" hint="Empty turns the transform off. {{wildcard(1)}} picks a token.">
          <Input mono value={stDest} onChange={e => setStDest(e.target.value)} placeholder="orders.{{wildcard(2)}}.{{wildcard(1)}}" />
        </Field>

        <SectionTitle className="md:col-span-2 mb-0">Metadata and consumer limits</SectionTitle>
        <Field label="Metadata" hint="One key=value per line; free text the server keeps with the stream." className="md:col-span-2">
          <Textarea rows={3} value={metadata} onChange={e => setMetadata(e.target.value)} placeholder={'owner=plant\nteam=data'} />
        </Field>
        <Field label="Consumer inactive threshold" hint="The most a consumer of this stream may ask for; empty leaves it to the consumer.">
          <DurationInput value={inactiveThreshold} unit={inactiveUnit} onValue={setInactiveThreshold} onUnit={setInactiveUnit} placeholder="none" />
        </Field>
        <Field label="Consumer max ack pending" hint="Empty = no limit">
          <Input type="number" min={0} value={maxAckPending} onChange={e => setMaxAckPending(e.target.value)} placeholder="none" />
        </Field>
      </form>
    </Dialog>
  );
}
