import { useEffect, useMemo, useState } from 'react';
import { Plug, Trash2, Unplug } from 'lucide-react';
import { newSavedConnection, serverLabel, type SavedConnection } from '../../lib/savedConnections';
import { appInfo } from '../../lib/storage';
import { useStore } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import { Button } from '../ui/Button';
import { confirm, Dialog } from '../ui/Dialog';
import ConnectionForm from './ConnectionForm';
import SavedConnectionList from './SavedConnectionList';

/** Manage saved connections: pick one, edit it, connect or disconnect. */
export default function ConnectionDialog() {
  const { open, editId } = useStore(s => s.connectionsDialog);
  const close = useStore(s => s.closeConnectionsDialog);
  const connections = useStore(s => s.connections);
  const saved = useSavedConnections(s => s.items);
  const upsert = useSavedConnections(s => s.upsert);
  const remove = useSavedConnections(s => s.remove);
  const connect = useSavedConnections(s => s.connect);
  const disconnect = useSavedConnections(s => s.disconnect);
  const connecting = useSavedConnections(s => s.connecting);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SavedConnection | null>(null);
  const [dirty, setDirty] = useState(false);

  // Pick the initial selection whenever the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dialog picks its selection when it opens, not when the saved list changes
  useEffect(() => {
    if (!open) return;
    const initial = editId ?? useStore.getState().activeConnId ?? saved[0]?.id ?? null;
    const item = saved.find(s => s.id === initial) ?? saved[0] ?? null;
    if (item) {
      setSelectedId(item.id);
      setDraft({ ...item });
    } else {
      const fresh = newSavedConnection({ name: 'Local' });
      setSelectedId(fresh.id);
      setDraft(fresh);
    }
    setDirty(false);
  }, [open, editId]);

  const liveById = useMemo(() => new Map(connections.map(c => [c.id, c])), [connections]);
  const isNew = !!draft && !saved.some(s => s.id === draft.id);

  const select = async (item: SavedConnection) => {
    if (
      dirty &&
      !(await confirm({ title: 'Discard changes?', message: 'You have unsaved changes to the current connection.', confirmLabel: 'Discard', danger: true }))
    )
      return;
    setSelectedId(item.id);
    setDraft({ ...item });
    setDirty(false);
  };

  const addNew = async () => {
    if (
      dirty &&
      !(await confirm({ title: 'Discard changes?', message: 'You have unsaved changes to the current connection.', confirmLabel: 'Discard', danger: true }))
    )
      return;
    const fresh = newSavedConnection();
    setSelectedId(fresh.id);
    setDraft(fresh);
    setDirty(true);
  };

  const patch = (p: Partial<SavedConnection>) => {
    setDraft(d => (d ? { ...d, ...p } : d));
    setDirty(true);
  };

  const normalized = (): SavedConnection | null => {
    if (!draft) return null;
    const servers = draft.servers.map(s => s.trim()).filter(Boolean);
    if (servers.length === 0) return null;
    return {
      ...draft,
      servers,
      name: draft.name.trim() || servers[0].replace(/^nats:\/\//, ''),
      subscriptions: draft.subscriptions.length ? draft.subscriptions : ['>'],
    };
  };

  const save = () => {
    const item = normalized();
    if (!item) return false;
    upsert(item);
    setDraft(item);
    setDirty(false);
    return true;
  };

  const saveAndConnect = async () => {
    if (!save() || !draft) return;
    if (await connect(draft.id)) close();
  };

  const del = async () => {
    if (!draft) return;
    if (
      !(await confirm({
        title: `Delete "${draft.name || serverLabel(draft)}"?`,
        message: 'The saved connection and its credentials are removed from this browser.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    if (liveById.has(draft.id)) await disconnect(draft.id);
    remove(draft.id);
    const next = saved.find(s => s.id !== draft.id) ?? null;
    if (next) {
      setSelectedId(next.id);
      setDraft({ ...next });
    } else {
      const fresh = newSavedConnection();
      setSelectedId(fresh.id);
      setDraft(fresh);
    }
    setDirty(false);
  };

  const live = draft ? liveById.get(draft.id) : undefined;
  const busy = draft ? connecting.has(draft.id) : false;
  const valid = !!normalized();

  return (
    <Dialog
      open={open}
      onOpenChange={o => !o && close()}
      title="Connections"
      description={
        appInfo.storage === 'file'
          ? 'Saved connections live in the app settings on this computer.'
          : 'Saved connections live in this browser. Credentials are stored unencrypted in local storage.'
      }
      width="xl"
      flush
      className="h-[640px]"
      footer={
        <>
          {!isNew && (
            <Button variant="ghost" className="mr-auto text-danger hover:text-danger" icon={<Trash2 size={13} />} onClick={del}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button variant="default" onClick={save} disabled={!dirty || !valid}>
            Save
          </Button>
          {live?.connected ? (
            <Button variant="danger" icon={<Unplug size={13} />} onClick={() => disconnect(live.id)}>
              Disconnect
            </Button>
          ) : (
            <Button variant="primary" icon={<Plug size={13} />} loading={busy} disabled={!valid} onClick={saveAndConnect}>
              {dirty ? 'Save & connect' : 'Connect'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex h-full min-h-0">
        <SavedConnectionList items={saved} live={liveById} selectedId={selectedId} draft={isNew ? draft : null} onSelect={select} onNew={addNew} />
        {draft && <ConnectionForm draft={draft} isNew={isNew} live={live} patch={patch} onSubmit={saveAndConnect} />}
      </div>
    </Dialog>
  );
}
