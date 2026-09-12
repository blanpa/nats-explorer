import { useState } from 'react';
import { Check } from 'lucide-react';
import { cn, copyToClipboard } from '../../lib/utils';

/** NATS server IDs are 56-character NKeys; a name that looks like one is not meant to be read. */
const isServerId = (s: string) => /^N[A-Z2-7]{55}$/.test(s);

/** Abbreviates a server ID to its first characters and keeps the full value in the tooltip. */
export function shortServerName(name: string): string {
  return isServerId(name) ? `${name.slice(0, 8)}…` : name;
}

/**
 * A server's name, or the NKey it fell back to when nobody gave it one.
 *
 * An ID is abbreviated where the room is a table cell, and shown whole with
 * `full` where there is a line for it -- a tooltip is not a way to read 56
 * characters, and it is certainly not a way to copy them. Either way a
 * click puts the whole thing on the clipboard, because an ID is something
 * to paste, never to retype.
 */
export function ServerName({ name, className, full }: { name: string; className?: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!isServerId(name)) return <span className={className}>{name}</span>;

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (await copyToClipboard(name)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`${name}\nClick to copy`}
      className={cn('font-mono inline-flex items-center gap-1 hover:text-accent max-w-full', full ? 'break-all text-left' : 'truncate', className)}
    >
      {full ? name : `${name.slice(0, 8)}…`}
      {copied && <Check size={12} className="text-ok shrink-0" />}
    </button>
  );
}
