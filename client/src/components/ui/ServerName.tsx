import { cn } from '../../lib/utils';

/** NATS server IDs are 56-character NKeys; a name that looks like one is not meant to be read. */
const isServerId = (s: string) => /^N[A-Z2-7]{55}$/.test(s);

/** Abbreviates a server ID to its first characters and keeps the full value in the tooltip. */
export function shortServerName(name: string): string {
  return isServerId(name) ? `${name.slice(0, 8)}…` : name;
}

export function ServerName({ name, className }: { name: string; className?: string }) {
  const short = shortServerName(name);
  return (
    <span className={cn(short !== name && 'font-mono', className)} title={short !== name ? name : undefined}>
      {short}
    </span>
  );
}
