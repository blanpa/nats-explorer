import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { type DecoderFormat, type DecoderRule, FORMAT_LABELS, newRule, useDecoders } from '../../lib/decoders';
import { cn } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Select, Textarea } from '../ui/Input';
import { EmptyState } from '../ui/misc';

const PLACEHOLDER: Record<DecoderFormat, string> = {
  msgpack: '',
  protobuf: 'syntax = "proto3";\npackage acme;\nmessage Reading {\n  string sensor_id = 1;\n  double value = 2;\n}',
  avro: '{ "type": "record", "name": "Reading", "fields": [ { "name": "sensor", "type": "string" }, { "name": "value", "type": "double" } ] }',
};

/**
 * Manages the payload decoders: which subject patterns carry MessagePack,
 * protobuf or Avro, and the schema to decode them with. Opened from the
 * payload viewer; `prefill` starts a rule for the subject being looked at.
 */
/** The dialog shell; the editor inside mounts fresh on every open so its draft starts from the subject at hand. */
export default function DecoderDialog({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: string }) {
  return open ? <DecoderEditor onClose={onClose} prefill={prefill} /> : null;
}

function DecoderEditor({ onClose, prefill }: { onClose: () => void; prefill?: string }) {
  const rules = useDecoders(s => s.rules);
  const save = useDecoders(s => s.save);
  const remove = useDecoders(s => s.remove);
  // Start on the rule for the subject at hand, or a fresh one for it.
  const [draft, setDraft] = useState<DecoderRule | null>(() =>
    prefill ? (rules.find(r => r.pattern === prefill) ?? newRule({ pattern: prefill })) : (rules[0] ?? null),
  );

  const patch = (p: Partial<DecoderRule>) => setDraft(d => (d ? { ...d, ...p } : d));
  const isNew = !!draft && !rules.some(r => r.id === draft.id);
  const canSave = !!draft && draft.pattern.trim().length > 0 && (draft.format === 'msgpack' || !!draft.schema?.trim());

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title="Payload decoders"
      description="Binary payloads on matching subjects are decoded with the format and schema of the first matching rule."
      width="lg"
      flush
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={!canSave}
            onClick={() => {
              if (draft) save({ ...draft, pattern: draft.pattern.trim() });
            }}
          >
            {isNew ? 'Add rule' : 'Save rule'}
          </Button>
        </>
      }
    >
      <div className="flex min-h-[360px] max-h-[60vh]">
        <div className="w-56 shrink-0 border-r border-line flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-line">
            <span className="text-xs font-medium text-muted">Rules</span>
            <IconButton label="New rule" size="xs" onClick={() => setDraft(newRule({ pattern: prefill ?? '' }))}>
              <Plus size={13} />
            </IconButton>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {rules.length === 0 && !draft && <EmptyState compact title="No rules yet" description="Add one for a subject pattern." />}
            {rules.map(r => (
              <button
                key={r.id}
                type="button"
                className={cn('list-row w-full text-left py-1.5', draft?.id === r.id && 'list-row-active')}
                onClick={() => setDraft(r)}
              >
                <span className="font-mono text-xs truncate flex-1">{r.pattern}</span>
                <span className="text-[10px] text-faint shrink-0">{FORMAT_LABELS[r.format]}</span>
              </button>
            ))}
            {draft && isNew && (
              <div className="list-row list-row-active py-1.5">
                <span className="font-mono text-xs truncate flex-1 italic">{draft.pattern || 'new rule'}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 overflow-auto p-4 flex flex-col gap-3">
          {draft ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Subject pattern" hint="NATS wildcards: * for one token, > for the rest.">
                  <Input mono value={draft.pattern} onChange={e => patch({ pattern: e.target.value })} placeholder="telemetry.>" autoFocus={isNew} />
                </Field>
                <Field label="Format">
                  <Select value={draft.format} onChange={e => patch({ format: e.target.value as DecoderFormat })}>
                    {(Object.keys(FORMAT_LABELS) as DecoderFormat[]).map(f => (
                      <option key={f} value={f}>
                        {FORMAT_LABELS[f]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {draft.format === 'protobuf' && (
                <Field label="Message type" hint="Fully qualified; the first message in the file when empty.">
                  <Input mono value={draft.messageType ?? ''} onChange={e => patch({ messageType: e.target.value })} placeholder="acme.Reading" />
                </Field>
              )}
              {draft.format !== 'msgpack' && (
                <Field label={draft.format === 'protobuf' ? '.proto source' : 'Avro schema (JSON)'} className="flex-1">
                  <Textarea
                    className="min-h-[180px] text-xs"
                    value={draft.schema ?? ''}
                    onChange={e => patch({ schema: e.target.value })}
                    placeholder={PLACEHOLDER[draft.format]}
                    spellCheck={false}
                  />
                </Field>
              )}
              {draft.format === 'msgpack' && <p className="text-xs text-muted">MessagePack is self-describing; no schema needed.</p>}
              {!isNew && (
                <div className="mt-auto pt-2">
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 size={13} />}
                    onClick={() => {
                      remove(draft.id);
                      setDraft(null);
                    }}
                  >
                    Delete rule
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState compact title="Select a rule" description="Or add a new one on the left." />
          )}
        </div>
      </div>
    </Dialog>
  );
}
