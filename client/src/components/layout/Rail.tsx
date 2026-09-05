import { Activity, Archive, Cable, KeyRound, Layers, Moon, Network, Radio, Server, Sun, type LucideIcon } from 'lucide-react';
import { MODULES, useStore, type Module } from '../../store';
import { Tooltip } from '../ui/misc';
import { cn } from '../../lib/utils';

const ICONS: Record<Module, LucideIcon> = {
  subjects: Network,
  jetstream: Layers,
  kv: KeyRound,
  objects: Archive,
  services: Radio,
  monitor: Activity,
  cluster: Server,
};

export default function Rail() {
  const module = useStore(s => s.module);
  const setModule = useStore(s => s.setModule);
  const theme = useStore(s => s.theme);
  const toggleTheme = useStore(s => s.toggleTheme);
  const openConnections = useStore(s => s.openConnectionsDialog);
  const connectedCount = useStore(s => s.connections.filter(c => c.connected).length);

  return (
    <nav className="w-12 shrink-0 flex flex-col items-center py-2 gap-1 bg-canvas border-r border-line" aria-label="Modules">
      {MODULES.map(m => {
        const Icon = ICONS[m.id];
        const active = module === m.id;
        return (
          <Tooltip key={m.id} content={m.label}>
            <button
              onClick={() => setModule(m.id)}
              aria-label={m.label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative w-9 h-9 rounded flex items-center justify-center transition-colors',
                active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg hover:bg-field',
              )}
            >
              {active && <span className="absolute -left-[6px] top-2 bottom-2 w-0.5 rounded-full bg-accent" />}
              <Icon size={17} strokeWidth={active ? 2.2 : 1.9} />
            </button>
          </Tooltip>
        );
      })}

      <div className="flex-1" />

      <Tooltip content={`${connectedCount} active connection${connectedCount === 1 ? '' : 's'}`}>
        <button
          onClick={() => openConnections()}
          aria-label="Manage connections"
          className="relative w-9 h-9 rounded flex items-center justify-center text-muted hover:text-fg hover:bg-field transition-colors"
        >
          <Cable size={17} strokeWidth={1.9} />
          {connectedCount > 0 && (
            <span className="absolute top-1.5 right-1.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-ok text-[9px] font-semibold text-black leading-[14px] text-center">
              {connectedCount}
            </span>
          )}
        </button>
      </Tooltip>
      <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
        <button
          onClick={toggleTheme}
          aria-label="Toggle theme"
          className="w-9 h-9 rounded flex items-center justify-center text-muted hover:text-fg hover:bg-field transition-colors"
        >
          {theme === 'dark' ? <Sun size={17} strokeWidth={1.9} /> : <Moon size={17} strokeWidth={1.9} />}
        </button>
      </Tooltip>
    </nav>
  );
}
