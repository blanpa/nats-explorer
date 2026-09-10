import type { ConsumerInfo } from 'shared';
import { api } from '../../lib/api';
import { subjectMatches } from '../../lib/subjectMatch';
import { useAsync } from '../../lib/useAsync';
import { formatNumber, formatTime, previewPayload } from '../../lib/utils';
import { SectionTitle } from '../ui/misc';
import { Since } from '../ui/misc';
import { toneClass } from '../ui/tone';

/** How many of the window to read; the oldest is the one that matters. */
const WINDOW = 20;

/**
 * The messages a consumer has been given and has not acknowledged.
 *
 * "numAckPending: 37" says a consumer is stuck without saying on what, and
 * the answer is nearly always the oldest one: the ack floor cannot move past
 * a message that is never acknowledged, so everything behind it waits on
 * that one. JetStream does not hand out the list of pending sequences, but
 * it does say where the floor is and how far delivery has got -- and the
 * messages in between are the window the answer is in.
 */
export default function AckPending({ connId, stream, consumer }: { connId: string; stream: string; consumer: ConsumerInfo }) {
  const from = consumer.ackFloor.streamSeq + 1;
  const to = consumer.delivered.streamSeq;
  const stuck = consumer.numAckPending > 0 && to >= from;
  const { data } = useAsync(() => (stuck ? api.getStreamMessages(connId, stream, { startSeq: from, limit: WINDOW }) : null), [connId, stream, from, to], {
    key: stuck ? `ackpending:${connId}:${stream}:${consumer.name}:${from}` : undefined,
  });
  if (!stuck) return null;

  // A filtered consumer was never given the subjects it does not take, so
  // they are not what it is waiting for.
  const filters = consumer.config.filterSubjects?.length
    ? consumer.config.filterSubjects
    : consumer.config.filterSubject
      ? [consumer.config.filterSubject]
      : [];
  const mine = (data?.messages ?? []).filter(m => m.seq <= to && (filters.length === 0 || filters.some(f => subjectMatches(f, m.subject))));
  const oldest = mine[0];

  return (
    <div className="mt-3 max-w-[900px]">
      <SectionTitle>Waiting for acknowledgement</SectionTitle>
      <div className="card px-3 py-2 flex flex-col gap-2">
        <div className="text-sm">
          {formatNumber(consumer.numAckPending)} delivered, not acknowledged. The ack floor stands at{' '}
          <span className="font-mono tabular-nums">{formatNumber(consumer.ackFloor.streamSeq)}</span> and cannot move past the oldest of them.
        </div>
        {oldest ? (
          <>
            <div className="text-xs text-muted">
              The oldest is <span className="font-mono text-fg tabular-nums">#{formatNumber(oldest.seq)}</span> on{' '}
              <span className="font-mono text-syn-key">{oldest.subject}</span>, stored {formatTime(oldest.timestamp)} · <Since ts={oldest.timestamp} />. Every
              other one waits behind it.
            </div>
            <div className="card divide-y divide-line/70 max-h-[220px] overflow-auto">
              {mine.map(m => {
                const p = previewPayload(m.payload, m.payloadType, 90);
                return (
                  <div key={m.seq} className="flex gap-3 px-3 py-1 text-xs font-mono">
                    <span className="text-muted tabular-nums w-16 shrink-0 text-right">{formatNumber(m.seq)}</span>
                    <span className="text-muted w-24 shrink-0">{formatTime(m.timestamp, false)}</span>
                    <span className="text-syn-key truncate max-w-[240px]">{m.subject}</span>
                    <span className={`truncate ${toneClass[p.tone]}`}>{p.text}</span>
                  </div>
                );
              })}
            </div>
            {consumer.numAckPending > mine.length && (
              <div className="text-xs text-faint">
                The {WINDOW} oldest of the window are shown. Some of these may already be acknowledged out of order -- an ack floor moves only when the lowest
                one is.
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-muted">The messages of that window are no longer in the stream.</div>
        )}
      </div>
    </div>
  );
}
