import { LogOut, ShieldCheck, WifiOff } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { wsClient } from '../../lib/ws';
import { IconButton } from '../ui/Button';
import { useStore } from '../../store';
import { Badge } from '../ui/misc';
import ConnectionSwitcher from '../connection/ConnectionSwitcher';

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" className="fill-raised" />
      <path d="M9 23V9l14 14V9" fill="none" stroke="rgb(var(--accent))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
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
        <Badge tone="danger" title="The NATS Explorer backend is not reachable. Reconnecting…">
          <WifiOff size={11} /> Backend offline
        </Badge>
      )}

      {/* The switcher is the one place for connections: switch, connect, disconnect, manage. */}
      <ConnectionSwitcher />
      <UserBadge />
    </header>
  );
}
