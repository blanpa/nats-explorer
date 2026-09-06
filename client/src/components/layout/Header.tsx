import { Cable, WifiOff } from 'lucide-react';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
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

export default function Header() {
  const wsOnline = useStore(s => s.wsOnline);
  const openConnections = useStore(s => s.openConnectionsDialog);

  return (
    <header className="h-11 shrink-0 flex items-center gap-3 px-3 bg-panel border-b border-line">
      <div className="flex items-center gap-2 pr-1 select-none">
        <Logo />
        <span className="text-sm font-semibold tracking-tight">NATS Explorer</span>
      </div>

      <div className="w-px h-5 bg-line" />

      <ConnectionSwitcher />

      <div className="flex-1" />

      {!wsOnline && (
        <Badge tone="danger" title="The NATS Explorer backend is not reachable. Reconnecting…">
          <WifiOff size={11} /> Backend offline
        </Badge>
      )}

      <Button variant="outline" size="sm" icon={<Cable size={13} />} onClick={() => openConnections()}>
        Connections
      </Button>
    </header>
  );
}
