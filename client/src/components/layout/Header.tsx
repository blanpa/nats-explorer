import { LogOut, ShieldCheck, WifiOff } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { wsClient } from '../../lib/ws';
import { IconButton } from '../ui/Button';
import { useStore } from '../../store';
import { Badge } from '../ui/misc';
import ConnectionSwitcher from '../connection/ConnectionSwitcher';

/**
 * A subject tree: a root and the branches under it. The letter it used to
 * be said nothing about the tool -- this is the thing the application
 * shows, and it still reads at 16px in a browser tab.
 */
function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" className="fill-raised" />
      <g stroke="rgb(var(--accent))" fill="rgb(var(--accent))">
        <path d="M8 9.25V22.75M8 12.75H15.4M8 22.75H20.4" strokeWidth="2.6" fill="none" strokeLinecap="round" />
        <circle cx="8" cy="9.25" r="3" strokeWidth="0" />
        <circle cx="19" cy="12.75" r="3" strokeWidth="0" />
        <circle cx="24" cy="22.75" r="3" strokeWidth="0" />
      </g>
    </svg>
  );
}

function UserBadge() {
  const mode = useAuth(s => s.mode);
  const user = useAuth(s => s.user);
  const role = useAuth(s => s.role);
  const authenticated = useAuth(s => s.authenticated);
  const logout = useAuth(s => s.logout);
  if (mode === 'none' || !authenticated) return null;
  return (
    <div className="flex items-center gap-1" title={role === 'admin' ? 'Admin: may publish and change things' : 'Viewer: read-only'}>
      <Badge tone={role === 'admin' ? 'accent' : 'neutral'}>
        <ShieldCheck size={11} /> {mode === 'users' ? `${user} · ${role}` : 'token'}
      </Badge>
      <IconButton
        label="Sign out"
        size="xs"
        onClick={() => {
          wsClient.disconnect();
          logout();
        }}
      >
        <LogOut size={13} />
      </IconButton>
    </div>
  );
}

export default function Header() {
  const wsOnline = useStore(s => s.wsOnline);

  return (
    <header className="h-11 shrink-0 flex items-center gap-3 px-3 bg-panel border-b border-line">
      <div className="flex items-center gap-2 pr-1 select-none">
        <Logo />
        <span className="text-sm font-semibold tracking-tight">NATS Explorer</span>
      </div>

      <div className="flex-1" />

      {!wsOnline && (
        <Badge tone="danger" title={`The NATS Explorer backend is not reachable at ${wsClient.endpoint || 'the websocket endpoint'}. Reconnecting…`}>
          <WifiOff size={11} /> Backend offline
        </Badge>
      )}

      {/* The switcher is the one place for connections: switch, connect, disconnect, manage. */}
      <ConnectionSwitcher />
      <UserBadge />
    </header>
  );
}
