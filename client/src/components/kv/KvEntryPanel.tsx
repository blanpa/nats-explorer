import { useState } from 'react';
import { Eraser, Pencil, Save, Trash2, X } from 'lucide-react';
import type { KvEntry } from 'shared';
import { formatBytes, formatDateTime, formatRelative, prettyJson, previewPayload } from '../../lib/utils';
import PayloadViewer from '../subjects/PayloadViewer';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Input';
import { Badge, SectionTitle } from '../ui/misc';
import { useCanWrite } from '../../lib/auth';

interface Props {
  entry: KvEntry;
  onSave: (value: string) => Promise<void>;
  onPurge: () => void;
  onDelete: () => void;
  /** tells the owner whether an edit is open, so live updates do not replace the draft */
  onEditing: (editing: boolean) => void;
}

/** Value, revision and history of one key, with an inline editor. */
export default function KvEntryPanel({ entry: e, onSave, onPurge, onDelete, onEditing }: Props) {
  const canWrite = useCanWrite();
  const [editing, setEditingState] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const setEditing = (v: boolean) => {
    setEditingState(v);
    onEditing(v);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(editValue);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 max-w-[1100px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-md font-semibold break-all">{e.key}</span>
        <Badge tone="neutral">rev {e.revision}</Badge>
        <Badge tone="neutral">{formatBytes(e.size)}</Badge>
        <span className="text-xs text-muted" title={formatDateTime(e.created)}>
          updated {formatRelative(e.created)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {editing ? (
            <>
              <Button variant="ghost" icon={<X size={13} />} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button variant="primary" icon={<Save size={13} />} loading={saving} onClick={save}>
                Save
              </Button>
            </>
          ) : !canWrite ? null : (
            <>
              <Button
                variant="outline"
                icon={<Pencil size={13} />}
                disabled={e.payloadType === 'binary'}
                onClick={() => {
                  setEditValue(e.payloadType === 'json' ? prettyJson(e.value) : e.value);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              <Button variant="outline" icon={<Eraser size={13} />} onClick={onPurge}>
                Purge
              </Button>
              <Button variant="danger" icon={<Trash2 size={13} />} onClick={onDelete}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <Textarea rows={14} value={editValue} onChange={ev => setEditValue(ev.target.value)} autoFocus />
      ) : (
        <PayloadViewer payload={e.value} type={e.payloadType} size={e.size} maxHeight={420} />
      )}

      {e.history && e.history.length > 0 && (
        <div>
          <SectionTitle>
            History · {e.history.length} {e.history.length === 1 ? 'revision' : 'revisions'}
          </SectionTitle>
          <div className="card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th className="num">Rev</th>
                  <th>Operation</th>
                  <th>Time</th>
                  <th>Value</th>
                  <th className="num">Size</th>
                </tr>
              </thead>
              <tbody>
                {[...e.history].reverse().map(h => {
                  const p = previewPayload(h.value, h.payloadType, 100);
                  return (
                    <tr key={h.revision} className={h.revision === e.revision ? 'bg-accent/5' : ''}>
                      <td className="num">{h.revision}</td>
                      <td>
                        <Badge tone={h.operation === 'put' ? 'ok' : h.operation === 'delete' ? 'warn' : 'danger'}>{h.operation}</Badge>
                      </td>
                      <td className="font-mono text-muted">{formatDateTime(h.created)}</td>
                      <td className="font-mono max-w-[480px] truncate text-muted">{h.operation === 'put' ? p.text : '–'}</td>
                      <td className="num text-muted">{formatBytes(h.size)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
