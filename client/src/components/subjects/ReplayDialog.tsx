import { useEffect, useRef, useState } from 'react';
import type { NatsMessage, StreamMessage } from 'shared';
import { type ReplayProgress, replayMessages } from '../../lib/replay';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';

/** Publishes the given messages again, oldest first, with a pause and an optional subject rewrite. */
export default function ReplayDialog({ messages, name, onClose }: { messages: (NatsMessage | StreamMessage)[]; name: string; onClose: () => void }) {
  const connections = useStore(s => s.connections.filter(c => c.connected));
  const activeConnId = useStore(s => s.activeConnId);
  const [connId, setConnId] = useState(activeConnId ?? connections[0]?.id ?? '');
  const [interval, setInterval] = useState('0');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [progress, setProgress] = useState<ReplayProgress | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    if (!connId) return;
    setRunning(true);
    abort.current = new AbortController();
    await replayMessages(connId, messages, { intervalMs: Number(interval) || 0, rewrite: from ? { from, to } : undefined }, setProgress, abort.current.signal);
    setRunning(false);
  };

  return (
    <Dialog
      open
      onOpenChange={o => !o && !running && onClose()}
      title={`Replay ${messages.length.toLocaleString('en-US')} messages`}
      description={`From ${name}, oldest first, through the publish API.`}
      footer={
        <>
          {progress && (
            <span className="mr-auto text-xs text-muted font-mono">
              {progress.sent} sent{progress.failed > 0 ? `, ${progress.failed} failed` : ''} of {progress.total}
              {progress.lastError ? ` · ${progress.lastError}` : ''}
            </span>
          )}
          {running ? (
            <Button variant="danger" onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {progress ? 'Close' : 'Cancel'}
              </Button>
              <Button variant="primary" disabled={!connId || messages.length === 0} onClick={start}>
                {progress ? 'Replay again' : 'Replay'}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Publish through">
          <select className="input" value={connId} onChange={e => setConnId(e.target.value)} disabled={running}>
            {connections.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pause between messages (ms)">
          <Input type="number" min={0} value={interval} onChange={e => setInterval(e.target.value)} disabled={running} />
        </Field>
        <Field label="Replace subject prefix" hint="Leave empty to publish on the original subjects.">
          <Input mono value={from} onChange={e => setFrom(e.target.value)} placeholder="uns.acme" disabled={running} />
        </Field>
        <Field label="with">
          <Input mono value={to} onChange={e => setTo(e.target.value)} placeholder="replay.acme" disabled={running} />
        </Field>
      </div>
      {messages.some(m => m.payloadType === 'binary') && <p className="text-xs text-warn mt-3">Binary payloads are skipped; the publish API carries text.</p>}
    </Dialog>
  );
}
