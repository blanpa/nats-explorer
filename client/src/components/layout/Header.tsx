import { Check, Link2, LogOut, ShieldCheck, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { wsClient } from '../../lib/ws';
import { IconButton } from '../ui/Button';
import { useStore } from '../../store';
import { Badge } from '../ui/misc';
import ConnectionSwitcher from '../connection/ConnectionSwitcher';
import { currentLink } from '../../lib/urlSync';

/**
 * A message leaving its publisher and spreading out through ">", the
 * wildcard for everything below a subject and the chevron that opens a
 * branch of the tree. The drawing of go-server/build/logo.svg without the
 * fold, which nobody sees at this size. The tile is the ultramarine of the icon
 * in both themes; the accent is its hue, adjusted until text in it reads.
 */
function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="logo-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6577ff" />
          <stop offset="1" stopColor="#2a2ecf" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7" fill="url(#logo-tile)" />
      <g fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7.1" cy="16" r="2.6" fill="#fff" stroke="none" />
        <path d="M12 11.8 16.2 16 12 20.2" strokeWidth="3" strokeOpacity=".68" />
        <path d="M17.9 8.2 25.7 16 17.9 23.8" strokeWidth="3.7" />
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
        <ShieldCheck size={11} /> {mode === 'users' || mode === 'oidc' || user ? `${user} · ${role}` : 'token'}
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

/**
 * The address of what is on screen, to the clipboard. The address bar says
 * the same, but the desktop shell has none, and a button is quicker than
 * selecting the bar in either.
 */
function CopyLink() {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? 'Link copied' : 'Copy a link to this view'}
      size="sm"
      onClick={() => {
        navigator.clipboard?.writeText(currentLink()).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={14} className="text-ok" /> : <Link2 size={14} />}
    </IconButton>
  );
}

export default function Header() {
  const wsOnline = useStore(s => s.wsOnline);

  return (
    <header className="h-11 shrink-0 flex items-center gap-3 px-3 bg-panel border-b border-line">
      <div className="flex items-center gap-2 pr-1 select-none">
        <Logo />
        <span className="text-sm font-semibold tracking-tight hidden sm:inline">NATS Explorer</span>
      </div>

      <div className="flex-1" />

      {!wsOnline && (
        <Badge tone="danger" title={`The NATS Explorer backend is not reachable at ${wsClient.endpoint || 'the websocket endpoint'}. Reconnecting…`}>
          <WifiOff size={11} /> Backend offline
        </Badge>
      )}

      {/* The switcher is the one place for connections: switch, connect, disconnect, manage. */}
      <ConnectionSwitcher />
      <CopyLink />
      <UserBadge />
    </header>
  );
}
