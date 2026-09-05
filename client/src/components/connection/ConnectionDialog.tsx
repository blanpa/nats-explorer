import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Plug, Plus, Trash2, Unplug } from 'lucide-react';
import type { AuthMethod } from 'shared';
import { useStore } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import { newSavedConnection, serverLabel, SYSTEM_TOPICS, type SavedConnection } from '../../lib/savedConnections';
import { cn, parseList } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '../ui/Input';
import { confirm, Dialog } from '../ui/Dialog';
import { Badge } from '../ui/misc';

const AUTH_OPTIONS: { value: AuthMethod; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'token', label: 'Token' },
  { value: 'userpass', label: 'Username / Password' },
  { value: 'nkey', label: 'NKey seed' },
  { value: 'jwt', label: 'Credentials file (JWT)' },
];

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  const liveById = useMemo(() => new Map(connections.map(c => [c.id, c])), [connections]);
  const isNew = !!draft && !saved.some(s => s.id === draft.id);

  const select = async (item: SavedConnection) => {
    if (dirty && !(await confirm({ title: 'Discard changes?', message: 'You have unsaved changes to the current connection.', confirmLabel: 'Discard', danger: true }))) return;
    setSelectedId(item.id);
    setDraft({ ...item });
    setDirty(false);
  };

  const addNew = async () => {
    if (dirty && !(await confirm({ title: 'Discard changes?', message: 'You have unsaved changes to the current connection.', confirmLabel: 'Discard', danger: true }))) return;
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
    return { ...draft, servers, name: draft.name.trim() || servers[0].replace(/^nats:\/\//, ''), subscriptions: draft.subscriptions.length ? draft.subscriptions : ['>'] };
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
    if (!(await confirm({ title: `Delete "${draft.name || serverLabel(draft)}"?`, message: 'The saved connection and its credentials are removed from this browser.', confirmLabel: 'Delete', danger: true }))) return;
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
      description="Saved connections live in this browser. Credentials are stored unencrypted in local storage."
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
        {/* Saved list */}
        <div className="w-60 shrink-0 border-r border-line flex flex-col min-h-0">
          <div className="flex items-center justify-between px-3 h-10 border-b border-line">
            <span className="pane-title">Saved</span>
            <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={addNew}>
              New
            </Button>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {saved.map(item => {
              const l = liveById.get(item.id);
              return (
                <button
                  key={item.id}
                  onClick={() => select(item)}
                  className={cn('list-row w-full text-left', selectedId === item.id && 'list-row-active')}
                >
                  <span className="status-dot" style={{ background: l?.connected ? l.color : l ? 'rgb(var(--warn))' : 'rgb(var(--fg-faint))' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.name || serverLabel(item)}</span>
                    <span className="block truncate text-xs text-muted font-mono">{serverLabel(item)}</span>
                  </span>
                </button>
              );
            })}
            {isNew && draft && (
              <div className="list-row list-row-active">
                <span className="status-dot bg-faint" />
                <span className="min-w-0 flex-1 truncate italic text-muted">{draft.name || 'New connection'}</span>
              </div>
            )}
          </div>
        </div>

        {/* Form */}
        {draft && (
          <form
            className="flex-1 min-w-0 overflow-auto px-5 py-4 flex flex-col gap-4"
            onSubmit={e => {
              e.preventDefault();
              saveAndConnect();
            }}
          >
            {live && (
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={live.connected ? 'ok' : 'warn'}>{live.connected ? 'Connected' : live.reconnecting ? 'Reconnecting' : 'Disconnected'}</Badge>
                {live.server && <span className="text-xs text-muted font-mono">{live.server}</span>}
                {live.lastError && <span className="text-xs text-danger font-mono truncate">{live.lastError}</span>}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Name">
                <Input value={draft.name} onChange={e => patch({ name: e.target.value })} placeholder="Production cluster" autoFocus={isNew} />
              </Field>
              <Field label="Authentication">
                <Select value={draft.authMethod} onChange={e => patch({ authMethod: e.target.value as AuthMethod })}>
                  {AUTH_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Servers" hint="One URL per line or comma separated. Scheme defaults to nats://." required>
              <Textarea rows={2} value={draft.servers.join('\n')} onChange={e => patch({ servers: e.target.value.split('\n') })} placeholder="nats://localhost:4222" />
            </Field>

            {draft.authMethod === 'token' && (
              <Field label="Token">
                <Input type="password" mono value={draft.token ?? ''} onChange={e => patch({ token: e.target.value })} autoComplete="off" />
              </Field>
            )}
            {draft.authMethod === 'userpass' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Username">
                  <Input value={draft.user ?? ''} onChange={e => patch({ user: e.target.value })} autoComplete="off" />
                </Field>
                <Field label="Password">
                  <Input type="password" value={draft.pass ?? ''} onChange={e => patch({ pass: e.target.value })} autoComplete="new-password" />
                </Field>
              </div>
            )}
            {draft.authMethod === 'nkey' && (
              <Field label="NKey seed" hint="User seed starting with SU…">
                <Input type="password" mono value={draft.nkeySeed ?? ''} onChange={e => patch({ nkeySeed: e.target.value })} placeholder="SUA…" autoComplete="off" />
              </Field>
            )}
            {draft.authMethod === 'jwt' && (
              <Field label="Credentials file content" hint="Paste the full .creds file including the JWT and the seed.">
                <Textarea rows={5} value={draft.creds ?? ''} onChange={e => patch({ creds: e.target.value })} placeholder="-----BEGIN NATS USER JWT-----" />
              </Field>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Subscriptions" hint="Subjects the explorer subscribes to. Use > for everything.">
                <Input mono value={draft.subscriptions.join(', ')} onChange={e => patch({ subscriptions: parseList(e.target.value) })} placeholder=">" />
              </Field>
              <Field label="Monitoring URL" hint="Optional. Defaults to http://<host>:8222 of the first server.">
                <Input mono value={draft.monitoringUrl ?? ''} onChange={e => patch({ monitoringUrl: e.target.value })} placeholder="http://localhost:8222" />
              </Field>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted">Transport</span>
                <Checkbox label="Use TLS" description="Required for tls:// servers with certificates." checked={!!draft.tls} onChange={e => patch({ tls: e.target.checked })} />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted">System subjects</span>
                {SYSTEM_TOPICS.map(st => (
                  <Checkbox
                    key={st.key}
                    label={
                      <span className="font-mono">
                        {st.subject}
                      </span>
                    }
                    description={st.description}
                    checked={!!draft.sysTopics?.[st.key]}
                    onChange={e => patch({ sysTopics: { ...draft.sysTopics, [st.key]: e.target.checked } })}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-start gap-2 text-xs text-muted rounded border border-warn/30 bg-warn/5 px-3 py-2 mt-auto">
              <AlertTriangle size={13} className="text-warn shrink-0 mt-0.5" />
              <span>
                Tokens, passwords and seeds are saved in this browser&apos;s local storage without encryption and sent to the NATS Explorer backend on connect. Do not use this on a shared machine with production credentials.
              </span>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
