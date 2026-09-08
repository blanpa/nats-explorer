import { useMemo, useState } from 'react';
import { Eye, X } from 'lucide-react';
import type { NatsMessage } from 'shared';
import { useStore, type LiveView } from '../../store';
import { messageKey, newerFirst, recentRate } from '../../lib/messages';
import { cn, formatCount, formatTime, previewPayload } from '../../lib/utils';
import { Button } from '../ui/Button';
import { PaneHeader } from '../ui/misc';
import ExportMenu from './ExportMenu';
import MessageList from './MessageList';
import MessagePanel from './MessagePanel';
import { toneClass } from '../ui/tone';

const MAX_MERGED = 500;

/** The latest message of a view: its own subject, or the newest below it for a branch. */
function latestOf(view: LiveView): NatsMessage | undefined {
  return view.messages[view.messages.length - 1] ?? view.branch[0];
}

function rateOf(view: LiveView): number {
  return recentRate(view.messages) + recentRate(view.branch.slice().reverse());
}

/**
 * Several subjects watched at once: the latest value of each, and one list
 * of everything that arrives on any of them, newest first.
 */
export default function MultiSubjectView() {
  const subjects = useStore(s => s.selectedSubjects);
  const live = useStore(s => s.live);
  const setSelectedSubject = useStore(s => s.setSelectedSubject);
  const revealSubject = useStore(s => s.revealSubject);
  const toggleSelectedSubject = useStore(s => s.toggleSelectedSubject);
  // A row of the merged list, shown below it like everywhere else.
  const [listMessage, setListMessage] = useState<NatsMessage | null>(null);

  const views = useMemo(() => subjects.map(s => live.get(s)).filter((v): v is LiveView => !!v), [subjects, live]);

  // Newest messages across every watched subject, exact and below.
  const merged = useMemo(() => {
    const out: NatsMessage[] = [];
    const seen = new Set<string>();
    for (const v of views) {
      const own = v.messages.length > MAX_MERGED ? v.messages.slice(v.messages.length - MAX_MERGED) : v.messages;
      for (const list of [own, v.branch]) {
        for (const m of list) {
          const k = messageKey(m);
          if (!seen.has(k)) {
            seen.add(k);
            out.push(m);
          }
        }
      }
    }
    out.sort(newerFirst);
    return out.length > MAX_MERGED ? out.slice(0, MAX_MERGED) : out;
  }, [views]);

  const loading = views.some(v => v.loading);

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader className="h-auto py-2 items-start">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-md text-fg">
            <Eye size={15} className="text-accent" />
            <span className="font-semibold">Watching {subjects.length} subjects</span>
          </div>
          <div className="flex flex-wrap items-center gap-1 mt-1.5">
            {subjects.map(s => (
              <span key={s} className="badge badge-neutral font-mono max-w-[360px]">
                <span className="truncate">{s}</span>
                <button type="button" className="ml-0.5 text-faint hover:text-fg" onClick={() => toggleSelectedSubject(s)} aria-label={`Stop watching ${s}`}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <div className="text-xs text-muted mt-1">
            {loading ? 'Loading history…' : `${formatCount(merged.length)} recent messages`} · Ctrl-click in the tree adds or removes a subject
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <ExportMenu messages={merged} name={`watch-${subjects.length}-subjects`} />
          <Button variant="outline" onClick={() => setSelectedSubject(null)}>
            Clear
          </Button>
        </div>
      </PaneHeader>

      <div className="shrink-0 grid gap-2 p-3 border-b border-line" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {views.map(v => {
          const last = latestOf(v);
          const p = last ? previewPayload(last.payload, last.payloadType, 120) : null;
          const rate = rateOf(v);
          return (
            <button
              type="button"
              key={v.subject}
              className="card text-left px-3 py-2 min-w-0 hover:border-accent/50 transition-colors"
              onClick={() => revealSubject(v.subject)}
              title="Open this subject alone"
            >
              <div className="font-mono text-xs text-muted truncate">{v.subject}</div>
              <div className={cn('font-mono text-sm truncate mt-0.5', p ? toneClass[p.tone] : 'text-faint')}>
                {p ? p.text : v.loading ? '…' : 'no message yet'}
              </div>
              <div className="flex items-center gap-2 text-xs text-faint mt-1">
                {last && <span>{formatTime(last.timestamp)}</span>}
                {rate > 0 && <span className="text-warn">{rate < 10 ? rate.toFixed(1) : Math.round(rate)} msg/s</span>}
                {v.error && <span className="text-danger truncate">{v.error}</span>}
              </div>
            </button>
          );
        })}
      </div>

      <MessageList className="flex-1 min-h-0" messages={merged} onOpen={revealSubject} onSelect={setListMessage} selected={listMessage} />
      {listMessage && <MessagePanel message={listMessage} onClose={() => setListMessage(null)} onOpenSubject={revealSubject} />}
    </div>
  );
}
