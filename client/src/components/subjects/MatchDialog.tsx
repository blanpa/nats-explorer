import { useEffect, useState } from 'react';
import { Bell, Database, FileCheck2, Radio, Search } from 'lucide-react';
import type { MatchResponse } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { subjectMatches } from '../../lib/subjectMatch';
import { useAlerts } from '../../store/alerts';
import { useStore } from '../../store';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Badge, EmptyState } from '../ui/misc';

/**
 * What one concrete subject runs into on its way through.
 *
 * `*` covers one token and `>` the rest, stream subjects overlap, and a
 * consumer filter one level too deep is invisible until nothing arrives.
 * Answering "why does my consumer not get this?" means reading four lists
 * and matching patterns by hand -- which is what this does instead.
 */
export default function MatchDialog({ subject, onClose }: { subject: string; onClose: () => void }) {
  const connId = useStore(s => s.activeConnId);
  const subscriptions = useStore(s => s.connections.find(c => c.id === s.activeConnId)?.subscriptions ?? []);
  const rules = useAlerts(s => s.rules);
  const loadAlerts = useAlerts(s => s.load);
  const [subj, setSubj] = useState(subject);
  const [data, setData] = useState<MatchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The rules live in the browser already, but only once the Alerts module
  // has been open; this answer must not depend on where someone has been.
  useEffect(() => {
    if (rules.length === 0) loadAlerts();
  }, [rules.length, loadAlerts]);

  useEffect(() => {
    if (!connId || !subj.trim()) return;
    let live = true;
    setBusy(true);
    api
      .matchSubject(connId, subj.trim())
      .then(r => live && (setData(r), setError(null)))
      .catch(e => live && (setError(errorMessage(e)), setData(null)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [connId, subj]);

  const subs = subscriptions.filter(p => subjectMatches(p, subj.trim()));
  const alerting = rules.filter(r => r.enabled !== false && subjectMatches(r.pattern, subj.trim()));
  const nothing = data && subs.length === 0 && alerting.length === 0 && data.streams.length === 0 && !data.schemaPattern;

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title="What matches this subject?"
      description="One concrete subject, and everything that would act on it: subscriptions, streams, consumers, alert rules and the pinned schema."
      width="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        <Field label="Subject" hint="A concrete subject, without wildcards -- the question is what one message would run into.">
          <Input mono value={subj} onChange={e => setSubj(e.target.value)} placeholder="orders.eu.created" spellCheck={false} autoFocus />
        </Field>

        {error && (
          <div className="text-sm text-danger" role="alert">
            {error}
          </div>
        )}

        <Group
          icon={<Radio size={13} />}
          title="Subscriptions of this connection"
          empty="No pattern of this connection covers it, so the explorer would not see it."
        >
          {subs.map(p => (
            <Row key={p} pattern={p} />
          ))}
        </Group>

        <Group
          icon={<Database size={13} />}
          title="Streams"
          empty={data?.jetStream === false ? 'JetStream could not be read on this connection.' : 'No stream stores it. A message on this subject is not kept.'}
        >
          {data?.streams.map(s => (
            <div key={s.name} className="px-3 py-2 flex flex-col gap-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-fg">{s.name}</span>
                <span className="text-xs text-muted">
                  through{' '}
                  {s.subjects.map(x => (
                    <code key={x} className="text-syn-key">
                      {x}
                    </code>
                  ))}
                </span>
              </div>
              {s.consumers.length === 0 ? (
                <span className="text-xs text-muted">No consumer would see it{s.filtered > 0 ? `; ${s.filtered} of them filter it out` : ''}.</span>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {s.consumers.map(c => (
                    <span key={c.name} className="text-muted">
                      <span className="font-mono text-fg">{c.name}</span>{' '}
                      {c.subjects?.length ? <code className="text-syn-key">{c.subjects.join(', ')}</code> : <span className="text-faint">no filter</span>}
                      {c.push && <span className="text-faint"> · push</span>}
                    </span>
                  ))}
                  {s.filtered > 0 && <span className="text-faint">{s.filtered} filtered out</span>}
                </div>
              )}
            </div>
          ))}
        </Group>

        <Group icon={<Bell size={13} />} title="Alert rules" empty="No rule watches it.">
          {alerting.map(r => (
            <Row key={r.id} pattern={r.pattern} note={r.name} />
          ))}
        </Group>

        <Group icon={<FileCheck2 size={13} />} title="Pinned schema" empty="No schema is pinned for it, so nothing judges its payload.">
          {data?.schemaPattern ? [<Row key="schema" pattern={data.schemaPattern} />] : []}
        </Group>

        {nothing && !busy && (
          <EmptyState compact icon={Search} title="Nothing acts on this subject" description="No subscription, stream, consumer, rule or schema covers it." />
        )}
      </div>
    </Dialog>
  );
}

/** One section of the answer; empty says what that means, not just "none". */
function Group({ icon, title, empty, children }: { icon: React.ReactNode; title: string; empty: string; children?: React.ReactNode }) {
  const list = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-muted mb-1">
        {icon}
        <span className="section-title">{title}</span>
        {list.length > 0 && <Badge tone="neutral">{list.length}</Badge>}
      </div>
      {list.length > 0 ? <div className="card divide-y divide-line/70">{list}</div> : <div className="text-xs text-faint">{empty}</div>}
    </div>
  );
}

function Row({ pattern, note }: { pattern: string; note?: string }) {
  return (
    <div className="px-3 py-1.5 flex items-baseline gap-3">
      <code className="font-mono text-syn-key">{pattern}</code>
      {note && <span className="text-xs text-muted truncate">{note}</span>}
    </div>
  );
}
