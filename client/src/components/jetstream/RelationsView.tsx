import { useMemo, useState } from 'react';
import { Archive, Eye, EyeOff, Hash, KeyRound, Layers, RefreshCw, Share2 } from 'lucide-react';
import type { ConsumerInfo, StreamInfo } from 'shared';
import { api } from '../../lib/api';
import { useSelectedStream } from '../../lib/pane';
import { useAsync } from '../../lib/useAsync';
import { cn, formatBytes, formatNumber, readSetting, writeSetting } from '../../lib/utils';
import { useStore } from '../../store';
import { IconButton } from '../ui/Button';
import { useRowOpen } from '../ui/OpenBeside';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import { CARD_W, CHIP_H, CHIP_W, CONSUMER_ROW_H, type LaidCard, layoutRelations, MAX_CONSUMER_ROWS } from './relationsLayout';

/** Consumers are read for this many streams at most; past that the picture shows counts only. */
const CONSUMER_STREAMS = 40;

const isInternal = (name: string) => name.startsWith('KV_') || name.startsWith('OBJ_');

interface Relations {
  streams: StreamInfo[];
  consumers: Map<string, ConsumerInfo[]>;
}

async function loadRelations(connId: string): Promise<Relations> {
  const streams = await api.listStreams(connId);
  const withConsumers = streams.filter(s => s.state.consumerCount > 0).slice(0, CONSUMER_STREAMS);
  const lists = await Promise.all(withConsumers.map(s => api.listConsumers(connId, s.name).catch(() => [] as ConsumerInfo[])));
  return { streams, consumers: new Map(withConsumers.map((s, i) => [s.name, lists[i]])) };
}

function displayName(card: LaidCard): string {
  return card.kind === 'kv' ? card.name.slice(3) : card.kind === 'objects' ? card.name.slice(4) : card.name;
}

function Card({ card, onOpen }: { card: LaidCard; onOpen: (e: React.MouseEvent, name: string) => void }) {
  const s = card.stream;
  const Icon = card.kind === 'kv' ? KeyRound : card.kind === 'objects' ? Archive : Layers;
  const shown = card.consumers.slice(0, MAX_CONSUMER_ROWS);
  return (
    <button
      type="button"
      className="absolute text-left rounded border border-line bg-panel hover:border-accent/60 focus-visible:border-accent shadow-sm flex flex-col overflow-hidden"
      style={{ left: card.x, top: card.y, width: CARD_W, height: card.h }}
      onClick={e => onOpen(e, card.name)}
      title={`Open ${card.name} (Ctrl-click: beside)`}
    >
      <div className="px-2.5 pt-2 flex items-center gap-1.5 min-w-0">
        <Icon size={13} className="text-accent shrink-0" />
        <span className="font-medium truncate">{displayName(card)}</span>
        <span className="ml-auto flex items-center gap-1 shrink-0">
          {card.kind !== 'stream' && <Badge tone="neutral">{card.kind === 'kv' ? 'KV' : 'objects'}</Badge>}
          {s.mirror && <Badge tone="info">mirror</Badge>}
          {s.sealed && <Badge tone="warn">sealed</Badge>}
          {s.replicas > 1 && <Badge tone="neutral">R{s.replicas}</Badge>}
        </span>
      </div>
      <div className="px-2.5 pt-0.5 text-xs text-muted font-mono tabular-nums truncate">
        {formatNumber(s.state.messages)} msgs · {formatBytes(s.state.bytes)}
        {s.state.consumerCount > 0 && ` · ${s.state.consumerCount} ${s.state.consumerCount === 1 ? 'consumer' : 'consumers'}`}
      </div>
      {shown.length > 0 && (
        <div className="mt-2 mx-1.5 border-t border-line/70 pt-1">
          {shown.map(c => {
            const filter = c.config.filterSubjects?.join(', ') || c.config.filterSubject || '';
            return (
              <div key={c.name} className="flex items-center gap-1.5 px-1 text-xs min-w-0" style={{ height: CONSUMER_ROW_H }}>
                <span className="text-faint shrink-0">↳</span>
                <span className="font-mono truncate shrink-0 max-w-[55%]">{c.name}</span>
                {filter && <span className="font-mono text-faint truncate min-w-0">{filter}</span>}
                <span className="ml-auto shrink-0 flex items-center gap-1 tabular-nums">
                  {c.paused && <Badge tone="warn">paused</Badge>}
                  {c.numAckPending > 0 && (
                    <span className="text-warn" title="delivered, not acknowledged">
                      {formatNumber(c.numAckPending)} unacked
                    </span>
                  )}
                  <span className={c.numPending > 0 ? 'text-fg' : 'text-faint'} title="not delivered yet">
                    {formatNumber(c.numPending)}
                  </span>
                </span>
              </div>
            );
          })}
          {card.consumers.length > MAX_CONSUMER_ROWS && (
            <div className="px-1 text-xs text-faint" style={{ height: CONSUMER_ROW_H }}>
              +{card.consumers.length - MAX_CONSUMER_ROWS} more consumers
            </div>
          )}
        </div>
      )}
      {s.republish && (
        <div className="px-2.5 text-xs text-muted truncate flex items-center gap-1" style={{ height: CONSUMER_ROW_H }}>
          <Share2 size={11} className="shrink-0 text-faint" />
          republish → <span className="font-mono">{s.republish.dest}</span>
        </div>
      )}
    </button>
  );
}

/**
 * How the streams of a connection hang together: which subjects go into
 * which stream, which stream mirrors or sources which, who consumes them.
 * Shown where a stream would be when none is open.
 */
export default function RelationsView() {
  const connId = useStore(s => s.activeConnId);
  const tick = useStore(s => s.refreshTick);
  const [, setSelected] = useSelectedStream();
  const open = useRowOpen('jetstream', setSelected);
  const [showSubjects, setShowSubjectsState] = useState(() => readSetting('ne.relations.subjects', true));
  const hideInternal = useStore(s => s.hideInternalStreams);
  const setHideInternal = useStore(s => s.setHideInternalStreams);
  const setShowSubjects = (b: boolean) => {
    setShowSubjectsState(b);
    writeSetting('ne.relations.subjects', b);
  };

  const { data, error, loading, initial, reload } = useAsync<Relations>(() => (connId ? loadRelations(connId) : null), [connId, tick], {
    key: `relations:${connId}`,
    interval: 15_000,
  });

  const streams = useMemo(() => (data?.streams ?? []).filter(s => !hideInternal || !isInternal(s.name)), [data, hideInternal]);
  const lay = useMemo(() => layoutRelations(streams, data?.consumers ?? new Map(), { subjects: showSubjects }), [streams, data, showSubjects]);
  const internal = (data?.streams ?? []).filter(s => isInternal(s.name)).length;
  const copies = streams.filter(s => s.mirror || s.sources?.length).length;

  const header = (
    <PaneHeader
      title="Relations"
      actions={
        <>
          <IconButton
            label={showSubjects ? 'Hide the subjects' : 'Show the subjects'}
            size="sm"
            onClick={() => setShowSubjects(!showSubjects)}
            className={cn(showSubjects && 'text-accent')}
          >
            <Hash size={14} />
          </IconButton>
          <IconButton
            label={hideInternal ? `Show KV and object stores${internal ? ` (${internal})` : ''}` : 'Hide KV and object stores'}
            size="sm"
            onClick={() => setHideInternal(!hideInternal)}
            className={cn(!hideInternal && 'text-accent')}
          >
            {hideInternal ? <EyeOff size={14} /> : <Eye size={14} />}
          </IconButton>
          <IconButton label="Refresh" size="sm" loading={loading && !initial} onClick={reload}>
            <RefreshCw size={14} />
          </IconButton>
        </>
      }
    >
      {data && (
        <span className="text-xs text-muted truncate">
          {formatNumber(streams.length)} streams{copies ? ` · ${copies} copying from others` : ''} · click one to open it
        </span>
      )}
    </PaneHeader>
  );

  if (initial && loading)
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  if (error && !data)
    return (
      <>
        {header}
        <ErrorState title="Cannot read the streams" message={error} />
      </>
    );
  if (streams.length === 0)
    return (
      <>
        {header}
        <EmptyState
          icon={Layers}
          title="No streams"
          description={
            internal && hideInternal ? 'Only KV and object store streams here; the eye shows them.' : 'Create a stream to start persisting messages.'
          }
        />
      </>
    );

  return (
    <>
      {header}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="relative" style={{ width: lay.width, height: lay.height }}>
          <svg className="absolute inset-0 pointer-events-none" width={lay.width} height={lay.height} aria-hidden="true">
            <defs>
              <marker id="rel-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" className="fill-line-strong" />
              </marker>
              <marker id="rel-arrow-copy" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" className="fill-accent" />
              </marker>
            </defs>
            {lay.links.map(l => (
              <g key={l.key}>
                <path
                  d={l.d}
                  fill="none"
                  className={l.kind === 'subject' ? 'stroke-line-strong' : 'stroke-accent'}
                  strokeWidth={l.kind === 'subject' ? 1.2 : 2}
                  strokeDasharray={l.kind === 'source' ? '6 4' : undefined}
                  markerEnd={`url(#${l.kind === 'subject' ? 'rel-arrow' : 'rel-arrow-copy'})`}
                />
                {l.kind !== 'subject' && (
                  <text x={l.mx} y={l.my - 6} textAnchor="middle" className="fill-muted text-[10px] stroke-canvas" strokeWidth={4} paintOrder="stroke">
                    {l.kind}
                    {l.lag ? ` · ${formatNumber(l.lag)} behind` : ''}
                  </text>
                )}
              </g>
            ))}
          </svg>
          {lay.chips.map(c => (
            <div
              key={c.id}
              className={cn(
                'absolute rounded px-2 text-xs font-mono flex items-center truncate',
                c.kind === 'subject' && 'bg-field text-syn-key border border-line',
                c.kind === 'more' && 'text-faint',
                c.kind === 'external' && 'border border-dashed border-line-strong text-muted',
              )}
              style={{ left: c.x, top: c.y, width: CHIP_W, height: CHIP_H }}
              title={c.kind === 'external' ? `${c.label} — in ${c.detail}` : c.kind === 'subject' ? `${c.label} → ${c.detail}` : undefined}
            >
              {c.kind === 'external' ? (
                <span className="truncate">
                  {c.label} <span className="text-faint">· {c.detail}</span>
                </span>
              ) : (
                <span className="truncate">{c.label}</span>
              )}
            </div>
          ))}
          {lay.cards.map(card => (
            <Card key={card.name} card={card} onOpen={open} />
          ))}
        </div>
      </div>
    </>
  );
}
