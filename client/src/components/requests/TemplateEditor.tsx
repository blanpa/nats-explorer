import { useEffect, useState } from 'react';
import { Copy, Save, Trash2 } from 'lucide-react';
import { draftDiffers, draftFromSaved, newSavedRequest, savedFromDraft, type RequestDraft } from '../../lib/savedRequests';
import { useStore } from '../../store';
import { useSavedRequests } from '../../store/savedRequests';
import { Button } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { EmptyState, PaneHeader } from '../ui/misc';
import { RequestForm, RequestResult, useRequestRunner, useSendConnection } from './RequestForm';

export default function TemplateEditor() {
  const selectedId = useStore(s => s.selectedTemplateId);
  const setSelected = useStore(s => s.setSelectedTemplateId);
  const template = useSavedRequests(s => s.items.find(t => t.id === selectedId) ?? null);
  const upsert = useSavedRequests(s => s.upsert);
  const remove = useSavedRequests(s => s.remove);

  const [draft, setDraft] = useState<RequestDraft | null>(null);
  const [name, setName] = useState('');
  const [connChoice, setConnChoice] = useState('');
  const runner = useRequestRunner();
  const { effective } = useSendConnection(connChoice);

  // Reload the form when another template is picked (not on every save).
  useEffect(() => {
    if (template) {
      setDraft(draftFromSaved(template));
      setName(template.name);
    } else {
      setDraft(null);
    }
    runner.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  if (!template || !draft) return <EmptyState title="Select a request" description="Pick a saved request on the left or create a new one. Templates can be run, repeated and exported as JSON." />;

  const dirty = name !== template.name || draftDiffers(draft, template);

  const save = () => {
    upsert({ ...savedFromDraft(draft, template), name: name.trim() || draft.subject.trim() || 'Untitled request' });
  };
  const duplicate = () => {
    const copy = newSavedRequest({ ...savedFromDraft(draft, template), id: undefined, name: `${name || 'Untitled'} (copy)` });
    upsert(copy);
    setSelected(copy.id);
  };
  const del = async () => {
    if (!(await confirm({ title: `Delete “${template.name}”?`, message: 'The template is removed from this browser.', confirmLabel: 'Delete', danger: true }))) return;
    remove(template.id);
    setSelected(null);
  };
  const send = () => {
    if (effective) runner.send(draft, effective);
  };

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onKeyDown={e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (dirty) save();
        }
      }}
    >
      <PaneHeader className="h-auto py-2">
        <Input className="max-w-[360px] font-medium" inputSize="sm" value={name} onChange={e => setName(e.target.value)} placeholder="Request name" aria-label="Request name" />
        {dirty && <span className="text-xs text-warn">unsaved</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant={dirty ? 'primary' : 'outline'} icon={<Save size={13} />} disabled={!dirty} onClick={save} title="Ctrl+S">
            Save
          </Button>
          <Button variant="outline" icon={<Copy size={13} />} onClick={duplicate}>
            Duplicate
          </Button>
          <Button variant="danger" icon={<Trash2 size={13} />} onClick={del}>
            Delete
          </Button>
        </div>
      </PaneHeader>
      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-4">
        <RequestForm draft={draft} onChange={setDraft} onSend={send} busy={runner.busy} canSend={!!effective} connId={effective ?? ''} onConnChange={setConnChoice} payloadRows={8} />
        <RequestResult error={runner.error} run={runner.run} reply={runner.reply} />
      </div>
    </div>
  );
}
