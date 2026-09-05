import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Loader2, Plug, Settings2, Unplug } from 'lucide-react';
import { useStore } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import { serverLabel } from '../../lib/savedConnections';
import { cn } from '../../lib/utils';

export default function ConnectionSwitcher() {
  const connections = useStore(s => s.connections);
  const activeConnId = useStore(s => s.activeConnId);
  const setActiveConnId = useStore(s => s.setActiveConnId);
  const openDialog = useStore(s => s.openConnectionsDialog);
  const saved = useSavedConnections(s => s.items);
  const connecting = useSavedConnections(s => s.connecting);
  const connect = useSavedConnections(s => s.connect);
  const disconnect = useSavedConnections(s => s.disconnect);

  const active = connections.find(c => c.id === activeConnId) ?? null;
  const liveById = new Map(connections.map(c => [c.id, c]));
  const idle = saved.filter(s => !liveById.has(s.id));

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={cn(
            'flex items-center gap-2 h-8 pl-2.5 pr-2 rounded border border-line bg-raised hover:bg-field hover:border-line-strong transition-colors max-w-[420px]',
            !active && 'text-muted',
          )}
          aria-label="Switch connection"
        >
          {active ? (
            <>
              <span
                className={cn('status-dot', active.connected ? '' : 'animate-pulse-dot')}
                style={{ background: active.connected ? active.color : 'rgb(var(--warn))' }}
              />
              <span className="text-sm font-medium truncate">{active.name}</span>
              <span className="text-xs text-muted font-mono truncate hidden md:inline">{active.server?.replace(/^nats:\/\//, '')}</span>
              {active.reconnecting && <span className="text-xs text-warn">reconnecting</span>}
            </>
          ) : (
            <>
              <Plug size={13} />
              <span className="text-sm">No connection</span>
            </>
          )}
          <ChevronDown size={13} className="text-muted shrink-0" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-[300px] max-w-[420px] rounded-lg border border-line bg-panel shadow-pop p-1 animate-fade-in outline-none"
        >
          {connections.length > 0 && (
            <>
              <DropdownMenu.Label className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-faint">Active</DropdownMenu.Label>
              {connections.map(c => (
                <DropdownMenu.Item
                  key={c.id}
                  onSelect={() => setActiveConnId(c.id)}
                  className="group flex items-center gap-2 px-2 h-9 rounded cursor-pointer text-sm outline-none data-[highlighted]:bg-field"
                >
                  <span className="status-dot" style={{ background: c.connected ? c.color : 'rgb(var(--warn))' }} />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block truncate text-xs text-muted font-mono">
                      {c.server?.replace(/^nats:\/\//, '') || c.servers?.[0]}
                      {c.reconnecting && <span className="text-warn ml-1">reconnecting…</span>}
                    </span>
                  </span>
                  {c.id === activeConnId && <Check size={13} className="text-accent shrink-0" />}
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      e.preventDefault();
                      disconnect(c.id);
                    }}
                    title="Disconnect"
                    className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-faint hover:text-danger hover:bg-danger/10 opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100"
                  >
                    <Unplug size={13} />
                  </button>
                </DropdownMenu.Item>
              ))}
            </>
          )}

          {idle.length > 0 && (
            <>
              {connections.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
              <DropdownMenu.Label className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-faint">Saved</DropdownMenu.Label>
              {idle.map(s => {
                const busy = connecting.has(s.id);
                return (
                  <DropdownMenu.Item
                    key={s.id}
                    disabled={busy}
                    onSelect={() => connect(s.id)}
                    className="flex items-center gap-2 px-2 h-9 rounded cursor-pointer text-sm outline-none data-[highlighted]:bg-field data-[disabled]:opacity-60"
                  >
                    <span className="status-dot bg-faint" />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate">{s.name || serverLabel(s)}</span>
                      <span className="block truncate text-xs text-muted font-mono">{serverLabel(s)}</span>
                    </span>
                    {busy ? <Loader2 size={13} className="animate-spin text-muted" /> : <Plug size={13} className="text-faint" />}
                  </DropdownMenu.Item>
                );
              })}
            </>
          )}

          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item
            onSelect={() => openDialog()}
            className="flex items-center gap-2 px-2 h-8 rounded cursor-pointer text-sm text-muted outline-none data-[highlighted]:bg-field data-[highlighted]:text-fg"
          >
            <Settings2 size={13} /> Manage connections…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
