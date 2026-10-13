import { useState } from 'react';
import { Check, Download, RotateCcw, Timer, XOctagon } from 'lucide-react';
import type { AckAction, PulledMessage } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { formatTime, previewPayload } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Select } from '../ui/Input';
import { Badge, SectionTitle } from '../ui/misc';
import { toast } from '../ui/Toast';

/**
 * What a client of a pull consumer sees: the next messages, handed over
 * without an ack, each with its fate to decide -- ack, nak, nak later,
 * term, or "still working". It is `nats consumer next --no-ack` with the
 * verdict in the hand of whoever is looking, and the way to find out what
 * a stuck worker would get and to clear the one message it chokes on.
 */
export default function ConsumerNext({ connId, stream, consumer, onChanged }: { connId: string; stream: string; consumer: string; onChanged: () => void }) {
  const [batch, setBatch] = useState(1);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<PulledMessage[]>([]);
  const [decided, setDecided] = useState<Map<string, AckAction>>(new Map());

  const fetchNext = async () => {
    setBusy(true);
    try {
      const res = await api.nextMessages(connId, stream, consumer, batch);
      setMessages(res.messages);
      setDecided(new Map());
      if (res.messages.length === 0) toast.info('Nothing to deliver', 'The consumer has no message waiting right now.');
      onChanged();
    } catch (err) {
      toast.error('Could not fetch', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (m: PulledMessage, action: AckAction, delayMs?: number) => {
    try {
      await api.ackMessage(connId, stream, consumer, m.reply, action, delayMs);
      setDecided(prev => new Map(prev).set(m.reply, action));
      onChanged();
    } catch (err) {
      toast.error('Not acknowledged', errorMessage(err));
    }
  };

  const decideAll = async (action: AckAction) => {
    for (const m of messages) if (!decided.has(m.reply)) await decide(m, action);
  };

  const open = messages.filter(m => !decided.has(m.reply));

  return (
    <div className="mt-3">
      <SectionTitle
        actions={
          <div className="flex items-center gap-1">
            <Select inputSize="sm" className="w-24" value={batch} onChange={e => setBatch(Number(e.target.value))} aria-label="How many">
              {[1, 5, 10, 25, 50].map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <Button size="xs" variant="outline" icon={<Download size={12} />} loading={busy} onClick={fetchNext}>
              Fetch next
            </Button>
            {open.length > 1 && (
              <>
                <Button size="xs" variant="ghost" onClick={() => decideAll('ack')}>
                  Ack all
                </Button>
                <Button size="xs" variant="ghost" onClick={() => decideAll('nak')}>
                  Nak all
                </Button>
              </>
            )}
          </div>
        }
      >
        Next messages
      </SectionTitle>
      <p className="text-xs text-muted mb-2">
        Handed over as a client would get them, and not acknowledged: each stays in flight until it is acked, naked or termed here, or the ack wait runs out and
        it is redelivered. The one a stuck worker chokes on can be termed away.
      </p>
      {messages.length > 0 && (
        <div className="card divide-y divide-line/70 max-w-[900px]">
          {messages.map(m => {
            const verdict = decided.get(m.reply);
            return (
              <div key={m.reply} className="flex items-center gap-2 px-3 py-1.5 text-sm font-mono">
                <span className="text-faint tabular-nums shrink-0">#{m.seq}</span>
                <span className="text-xs text-faint tabular-nums shrink-0">{formatTime(m.timestamp)}</span>
                <span className="text-syn-key truncate max-w-[220px]">{m.subject}</span>
                {(m.deliveries ?? 1) > 1 && (
                  <Badge tone="warn" title="How often this message was delivered already">
                    delivery {m.deliveries}
                  </Badge>
                )}
                <span className="text-muted truncate flex-1 text-xs">{previewPayload(m.payload, m.payloadType, 120).text}</span>
                {verdict ? (
                  <Badge tone={verdict === 'ack' ? 'ok' : verdict === 'term' ? 'danger' : 'neutral'}>{verdict === 'progress' ? 'working' : verdict}</Badge>
                ) : (
                  <span className="flex items-center gap-0.5 shrink-0">
                    <IconButton label="Ack: done with it" size="xs" onClick={() => decide(m, 'ack')}>
                      <Check size={12} className="text-ok" />
                    </IconButton>
                    <IconButton label="Nak: deliver it again" size="xs" onClick={() => decide(m, 'nak')}>
                      <RotateCcw size={12} />
                    </IconButton>
                    <IconButton label="Nak with a delay: deliver it again in a minute" size="xs" onClick={() => decide(m, 'nak', 60_000)}>
                      <Timer size={12} />
                    </IconButton>
                    <IconButton label="Term: never deliver it again" size="xs" onClick={() => decide(m, 'term')}>
                      <XOctagon size={12} className="text-danger" />
                    </IconButton>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
