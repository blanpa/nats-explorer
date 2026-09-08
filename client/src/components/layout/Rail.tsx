import { Activity, Archive, Bell, KeyRound, Layers, Moon, Network, Radio, ScrollText, Send, Server, Sun, type LucideIcon } from 'lucide-react';
import { MODULES, useStore, type Module } from '../../store';
import { useAlerts, worstSeverity } from '../../store/alerts';
import { Tooltip } from '../ui/misc';
import { cn } from '../../lib/utils';

const ICONS: Record<Module, LucideIcon> = {
  subjects: Network,
  jetstream: Layers,
  kv: KeyRound,
  objects: Archive,
  services: Radio,
  requests: Send,
  monitor: Activity,
  cluster: Server,
  alerts: Bell,
  audit: ScrollText,
};

export default function Rail() {
  const module = useStore(s => s.module);
  // The alerts entry carries the count, so a firing rule is visible from every module.
  const active = useAlerts(s => s.active);
  const setModule = useStore(s => s.setModule);
  const theme = useStore(s => s.theme);
  const toggleTheme = useStore(s => s.toggleTheme);

  return (
    <nav className="w-12 shrink-0 flex flex-col items-center py-2 gap-1 bg-canvas border-r border-line" aria-label="Modules">
      {MODULES.map(m => {
        const Icon = ICONS[m.id];
        const isActive = module === m.id;
        return (
          <Tooltip key={m.id} content={m.label}>
            <button
              type="button"
              onClick={() => setModule(m.id)}
              aria-label={m.label}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'relative w-9 h-9 rounded flex items-center justify-center transition-colors',
                isActive ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg hover:bg-field',
              )}
            >
              {isActive && <span className="absolute -left-[6px] top-2 bottom-2 w-0.5 rounded-full bg-accent" />}
              <Icon size={17} strokeWidth={isActive ? 2.2 : 1.9} />
              {m.id === 'alerts' && active.length > 0 && (
                <span
                  className={cn(
                    'absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full text-[10px] font-semibold tabular-nums flex items-center justify-center text-white',
                    worstSeverity(active) === 'critical' ? 'bg-danger' : 'bg-warn',
                  )}
                >
                  {active.length > 99 ? '99+' : active.length}
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}

      <div className="flex-1" />

      <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
        <button
          type="button"
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
