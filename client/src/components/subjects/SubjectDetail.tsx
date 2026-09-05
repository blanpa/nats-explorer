import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Diff, FolderTree, History, LineChart, MousePointerClick, Send, X } from 'lucide-react';
import { useBranchMessages, useStore, useSubjectMessages } from '../../store';
import { cn, copyToClipboard, formatBytes, formatTime, prettyJson, previewPayload } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Badge, EmptyState, PaneHeader } from '../ui/misc';
import PayloadViewer from './PayloadViewer';
import ValueChart from './ValueChart';
import DiffView from './DiffView';
import PublishPanel from './PublishPanel';

export default function SubjectDetail() {
  const subject = useStore(s => s.selectedSubject);
  const messages = useSubjectMessages(subject);
  const selectedMessage = useStore(s => s.selectedMessage);
  const setSelectedMessage = useStore(s => s.setSelectedMessage);
  const connections = useStore(s => s.connections);
  const publishOpen = useStore(s => s.publishOpen);
  const setPublishOpen = useStore(s => s.setPublishOpen);
  const prefillPublish = useStore(s => s.prefillPublish);

  const [showHistory, setShowHistory] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [chartField, setChartField] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const setSelectedSubject = useStore(s => s.setSelectedSubject);
  // A selected branch (no messages of its own) shows what flows below it.
  const branchMessages = useBranchMessages(subject && messages.length === 0 ? subject : null);

  // Reset per-subject UI state when the subject changes.
  useEffect(() => {
    setChartField(null);
    setShowDiff(false);
  }, [subject]);

  const latest = messages[messages.length - 1];
  const pinned = selectedMessage && selectedMessage.subject === subject ? selectedMessage : null;
  const display = pinned ?? latest;
  const displayIndex = display ? messages.lastIndexOf(display) : -1;
  const previous = displayIndex > 0 ? messages[displayIndex - 1] : null;

  const rate = useMemo(() => {
    if (!subject) return 0;
    const cutoff = Date.now() - 10_000;
    let n = 0;
    for (let i = messages.length - 1; i >= 0 && messages[i].timestamp >= cutoff; i--) n++;
    return n / 10;
  }, [messages, subject]);

  if (!subject) {
    return (
      <EmptyState
        icon={MousePointerClick}
        title="Select a subject"
        description="Pick a subject in the tree to see its latest value, history and headers. Numeric JSON fields can be charted over time."
      />
    );
  }

  const copySubject = async () => {
    if (await copyToClipboard(subject)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const segments = subject.split('.');
  const connOf = (id?: string) => connections.find(c => c.id === id);
  const isBranch = messages.length === 0 && branchMessages.length > 0;

  const header = (
    <PaneHeader className="h-auto py-2 items-start">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-md text-fg break-all leading-snug">
          {segments.map((seg, i) => (
            <span key={i}>
              <span className={i === segments.length - 1 ? 'font-semibold' : ''}>{seg}</span>
              {i < segments.length - 1 && <span className="text-faint mx-px">.</span>}
            </span>
          ))}
          {isBranch && <span className="text-faint">.&gt;</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-muted">
          {isBranch ? (
            <span>{branchMessages.length.toLocaleString()} recent messages below this subject</span>
          ) : (
            <>
              <span>{messages.length.toLocaleString()} buffered</span>
              {rate > 0 && <span className="text-warn">{rate < 10 ? rate.toFixed(1) : Math.round(rate)} msg/s</span>}
              {latest && <span>last {formatTime(latest.timestamp)}</span>}
              {latest && <span>{formatBytes(latest.size)}</span>}
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <IconButton label="Copy subject" onClick={copySubject}>
          {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
        </IconButton>
        <Button variant="outline" icon={<Send size={13} />} onClick={() => prefillPublish({ subject, payload: display ? prettyJson(display.payload) : undefined })}>
          Publish here
        </Button>
      </div>
    </PaneHeader>
  );

  if (isBranch) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {header}
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Subject</th>
                <th>Payload</th>
                <th className="num">Size</th>
              </tr>
            </thead>
            <tbody>
              {branchMessages.map((m, i) => {
                const p = previewPayload(m.payload, m.payloadType, 90);
                return (
                  <tr key={`${m.subject}-${m.timestamp}-${i}`} className="cursor-pointer" onClick={() => setSelectedSubject(m.subject)} title="Open this subject">
                    <td className="font-mono text-muted">{formatTime(m.timestamp)}</td>
                    <td className="font-mono">
                      <span className="text-faint">{subject}.</span>
                      {m.subject.slice(subject.length + 1)}
                    </td>
                    <td className={cn('font-mono max-w-[480px] truncate', p.tone === 'num' ? 'text-syn-num' : p.tone === 'str' ? 'text-syn-str' : p.tone === 'bool' ? 'text-syn-bool' : 'text-muted')}>{p.text}</td>
                    <td className="num text-muted">{formatBytes(m.size)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-4 py-3 text-xs text-faint flex items-center gap-1.5">
            <FolderTree size={12} /> Showing buffered messages of all subjects below <span className="font-mono">{subject}</span>. Click a row to open that subject.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {header}

      <div className="flex-1 min-h-0 flex">
        {showHistory && (
          <div className="w-72 shrink-0 border-r border-line flex flex-col min-h-0">
            <div className="flex items-center h-9 px-3 border-b border-line text-xs text-muted">
              <span className="section-title">History</span>
              <span className="ml-auto">{messages.length} newest first</span>
            </div>
            <div className="flex-1 overflow-auto">
              {[...messages].reverse().map((m, i) => {
                const active = m === display;
                const p = previewPayload(m.payload, m.payloadType, 48);
                return (
                  <div
                    key={`${m.timestamp}-${i}`}
                    className={cn('list-row py-1', active && 'list-row-active')}
                    onClick={() => setSelectedMessage(m === latest ? null : m)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-muted">{formatTime(m.timestamp)}</span>
                        <span className="ml-auto text-faint">{formatBytes(m.size)}</span>
                      </div>
                      <div className="font-mono text-xs truncate text-fg/80">{p.text}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex-1 min-w-0 min-h-0 overflow-auto p-4 flex flex-col gap-4">
          {!display ? (
            <EmptyState compact title="Waiting for a message on this subject" description="Nothing has been received on this exact subject since you connected." />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" active={showHistory} icon={<History size={13} />} onClick={() => setShowHistory(v => !v)}>
                  History
                </Button>
                <Button size="sm" variant="outline" active={showDiff} disabled={!previous} icon={<Diff size={13} />} onClick={() => setShowDiff(v => !v)}>
                  Diff to previous
                </Button>
                {chartField && (
                  <Button size="sm" variant="outline" active icon={<LineChart size={13} />} onClick={() => setChartField(null)}>
                    Chart: <span className="font-mono">{chartField}</span> <X size={12} />
                  </Button>
                )}
                {pinned && (
                  <Badge tone="info" className="cursor-pointer" title="Showing an older message. Click to follow the latest again.">
                    <span onClick={() => setSelectedMessage(null)}>pinned · {formatTime(pinned.timestamp)} · back to live</span>
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-2 text-xs text-muted">
                  {display.payloadType === 'json' && !chartField && <span className="hidden lg:inline">Click a number to chart it</span>}
                  <Badge tone="neutral">{display.payloadType}</Badge>
                </div>
              </div>

              {chartField && (
                <div className="card px-3 py-2">
                  <ValueChart messages={messages} fieldPath={chartField} />
                </div>
              )}

              <PayloadViewer
                payload={display.payload}
                type={display.payloadType}
                size={display.size}
                onFieldSelect={p => setChartField(f => (f === p ? null : p))}
                selectedField={chartField}
                maxHeight={showDiff ? 320 : undefined}
              />

              {showDiff && previous && (
                <div>
                  <div className="section-title mb-1">Diff · previous → current</div>
                  <DiffView prev={prettyJson(previous.payload)} curr={prettyJson(display.payload)} />
                </div>
              )}

              {display.headers && Object.keys(display.headers).length > 0 && (
                <div>
                  <div className="section-title mb-1">Headers</div>
                  <div className="card divide-y divide-line/70 text-sm font-mono">
                    {Object.entries(display.headers).map(([k, vals]) => (
                      <div key={k} className="flex gap-3 px-3 py-1.5">
                        <span className="text-syn-key w-48 shrink-0 truncate">{k}</span>
                        <span className="text-syn-str break-all">{vals.join(', ')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="text-xs text-faint flex flex-wrap gap-x-4 gap-y-1">
                <span>received {new Date(display.timestamp).toLocaleString()}.{String(display.timestamp % 1000).padStart(3, '0')}</span>
                {display.reply && (
                  <span>
                    reply-to <span className="font-mono text-muted">{display.reply}</span>
                  </span>
                )}
                {display.connId && connections.filter(c => c.connected).length > 1 && (
                  <span className="flex items-center gap-1">
                    via <span className="status-dot" style={{ background: connOf(display.connId)?.color }} /> {connOf(display.connId)?.name}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Publish drawer */}
      <div className="shrink-0 border-t border-line bg-panel">
        <button
          className="w-full h-8 flex items-center gap-2 px-3 text-xs font-semibold uppercase tracking-wider text-muted hover:text-fg"
          onClick={() => setPublishOpen(!publishOpen)}
          aria-expanded={publishOpen}
        >
          <Send size={12} />
          Publish
          <span className="ml-auto">{publishOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</span>
        </button>
        {publishOpen && (
          <div className="border-t border-line max-h-[45vh] overflow-auto">
            <PublishPanel />
          </div>
        )}
      </div>
    </div>
  );
}
