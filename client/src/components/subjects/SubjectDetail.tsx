import { useCallback, useEffect, useState } from 'react';
import type { NatsMessage } from 'shared';
import { Check, Copy, Diff, Eraser, FolderTree, History, LineChart, MousePointerClick, Send, X } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useCanWrite } from '../../lib/auth';
import { clearSubject, loadOlder, loadOlderBranch } from '../../lib/feed';
import { byArrival, newerFirst, recentRate } from '../../lib/messages';
import { useAsync } from '../../lib/useAsync';
import { copyToClipboard, extractNumber, formatBytes, formatCount, formatTime, prettyJson, readSetting, writeSetting } from '../../lib/utils';
import { HISTORY_RAIL_WIDTH, MAX_LOADED_MESSAGES, useBranchMessages, useLiveView, useStore, useSubjectMessages } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { Badge, EmptyState, PaneHeader } from '../ui/misc';
import { toast } from '../ui/Toast';
import DiffView from './DiffView';
import ExportMenu from './ExportMenu';
import { HistorySearchInput, SearchSummary, useHistorySearch } from './HistorySearch';
import RangePicker, { type TimeRange } from './RangePicker';
import HistoryRail from './HistoryRail';
import { ResizeHandle } from '../layout/ResizeHandle';
import MessageList from './MessageList';
import MessagePanel from './MessagePanel';
import MultiSubjectView from './MultiSubjectView';
import { findBookmark, useBookmarks } from '../../lib/bookmarks';
import BookmarkButton from './BookmarkButton';
import PayloadViewer from './PayloadViewer';
import { messageForPoint, windowFor } from './pickMessage';
import PublishDrawer from './PublishDrawer';
import SchemaPanel from './SchemaPanel';
import TrendStrip from './TrendStrip';
import ValueChart from './ValueChart';

/** Messages per request, for the first page of a range and every one after. */
const RANGE_PAGE = 2000;

export default function SubjectDetail() {
  const count = useStore(s => s.selectedSubjects.length);
  if (count > 1) return <MultiSubjectView />;
  return <SingleSubjectView />;
}

function SingleSubjectView() {
  const subject = useStore(s => s.selectedSubject);
  const messages = useSubjectMessages(subject);
  const branchMessages = useBranchMessages(subject);
  const view = useLiveView(subject);
  const selectedMessage = useStore(s => s.selectedMessage);
  const setSelectedMessage = useStore(s => s.setSelectedMessage);
  // Jumps from a list or a panel open the branches above the subject.
  const revealSubject = useStore(s => s.revealSubject);
  const connections = useStore(s => s.connections);
  const prefillPublish = useStore(s => s.prefillPublish);
  const historyDb = useStore(s => s.historyDb);
  const railWidth = useStore(s => s.historyRailWidth);
  const setRailWidth = useStore(s => s.setHistoryRailWidth);

  const [showHistory, setShowHistoryState] = useState(() => readSetting('ne.historyRail', true));
  const setShowHistory = (v: boolean) => {
    writeSetting('ne.historyRail', v);
    setShowHistoryState(v);
  };
  const [showDiff, setShowDiff] = useState(false);
  const [chartField, setChartField] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [rangeState, setRange] = useState<TimeRange | null>(null);
  // Switching the persistent history off takes the range with it: without a
  // database there is nothing behind it and the view would stay empty.
  const range = historyDb ? rangeState : null;
  // A row of the search results or the branch list, shown under it.
  const [listMessage, setListMessage] = useState<NatsMessage | null>(null);
  const search = useHistorySearch(subject, range);
  const bookmarks = useBookmarks(s => s.items);
  const canWrite = useCanWrite();
  // Messages of the chosen time range from the persistent history.
  const ranged = useAsync(
    () => (subject && range ? api.getHistoryRange(subject, { from: range.from, to: range.to, branch: true, limit: RANGE_PAGE }) : null),
    [subject, range?.from, range?.to],
    { key: subject && range ? `range:${subject}:${range.from}:${range.to}` : undefined },
  );
  const [loadingOlderRange, setLoadingOlderRange] = useState(false);
  const { data: rangedData, setData: setRangedData } = ranged;

  // Pages backwards through the range, the same way the live history does:
  // every connection that contributed keeps its own (timestamp, sequence)
  // cursor, so messages sharing a millisecond are not skipped.
  const loadOlderRange = useCallback(async () => {
    if (!subject || !range || !rangedData?.more || loadingOlderRange) return;
    if (rangedData.messages.length >= MAX_LOADED_MESSAGES) return;
    const cursors = new Map<string, NatsMessage>();
    // Newest first, so the last message of a connection is its oldest.
    for (const m of rangedData.messages) if (m.connId) cursors.set(m.connId, m);
    if (cursors.size === 0) return;
    setLoadingOlderRange(true);
    try {
      const pages = await Promise.all(
        [...cursors].map(([connId, m]) =>
          api.getHistoryRange(subject, {
            from: range.from,
            to: range.to,
            branch: true,
            limit: RANGE_PAGE,
            connId,
            beforeTs: m.timestamp,
            beforeSeq: m.sequence,
          }),
        ),
      );
      const older = pages.flatMap(p => p.messages);
      setRangedData(prev => (prev ? { ...prev, messages: prev.messages.concat(older), more: pages.some(p => p.more) } : prev));
    } catch (err) {
      toast.error('Older messages not loaded', errorMessage(err));
    } finally {
      setLoadingOlderRange(false);
    }
  }, [subject, range, rangedData, loadingOlderRange, setRangedData]);

  // Reset per-subject UI state when the subject changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset belongs to a subject change, which the body itself does not read
  useEffect(() => {
    setChartField(null);
    setShowDiff(false);
    setRange(null);
    setListMessage(null);
  }, [subject]);

  // The chart's history comes downsampled from the server and is refreshed
  // now and then; live messages fill the gap in between.
  const { data: series } = useAsync(
    () => (subject && chartField ? api.getSeries(subject, chartField, { points: 600, from: range?.from, to: range?.to }) : null),
    [subject, chartField, range?.from, range?.to],
    {
      interval: range ? undefined : 15_000,
      key: subject && chartField ? `series:${subject}:${chartField}:${range?.from ?? 'live'}` : undefined,
    },
  );

  if (!subject) {
    return <EmptyState icon={MousePointerClick} title="Select a subject" description="Ctrl-click watches several subjects at once." />;
  }

  // A time range is the same view with other data: the messages come from
  // the database instead of the live feed, oldest first as everywhere else.
  const rangedAll = ranged.data?.messages ?? [];
  const rangedOwn = range ? [...rangedAll].filter(m => m.subject === subject).sort(byArrival) : [];
  const rangedBelow = range ? [...rangedAll].filter(m => m.subject !== subject).sort(newerFirst) : [];
  const shownMessages = range ? rangedOwn : messages;
  const shownBelow = range ? rangedBelow : branchMessages;

  const latest = shownMessages[shownMessages.length - 1];
  const pinned = selectedMessage && selectedMessage.subject === subject ? selectedMessage : null;
  const display = pinned ?? latest;
  const displayIndex = display ? shownMessages.lastIndexOf(display) : -1;
  const previous = displayIndex > 0 ? shownMessages[displayIndex - 1] : null;
  const rate = recentRate(messages);
  // A selected branch (no messages of its own) shows what flows below it.
  const isBranch = shownMessages.length === 0 && shownBelow.length > 0;
  const connOf = (id?: string) => connections.find(c => c.id === id);

  // Forgetting one subject, or a branch with everything under it. The rest
  // of the recorded history stays.
  const clearThis = async () => {
    const branch = isBranch || shownBelow.length > 0;
    const ok = await confirm({
      title: branch ? `Clear the history below ${subject}?` : `Clear the history of ${subject}?`,
      message: branch
        ? 'The recorded messages of this subject and everything below it are forgotten, in memory and on disk. New messages are recorded again.'
        : 'The recorded messages of this subject are forgotten, in memory and on disk. New messages are recorded again.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    try {
      const cleared = await clearSubject(subject, branch);
      toast.success('History cleared', `${cleared} subject${cleared === 1 ? '' : 's'} forgotten.`);
    } catch (err) {
      toast.error('Could not clear the history', errorMessage(err));
    }
  };

  const copySubject = async () => {
    if (await copyToClipboard(subject)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  // Clicking a chart point pins the message behind it. The value decides,
  // not only the time: a downsampled or aggregated point covers several
  // messages, and the interesting one is the one that produced the peak.
  const pickPoint = async (point: { t: number; v: number }) => {
    if (!chartField) return;
    const win = windowFor(series?.source);
    const local = messageForPoint(shownMessages, chartField, point, win);
    if (local) {
      setSelectedMessage(local);
      return;
    }
    if (!useStore.getState().historyDb) {
      toast.info('Message no longer here', 'This point is older than what the browser holds. Switching the persistent history on keeps it.');
      return;
    }
    try {
      const res = await api.getHistoryRange(subject, { from: point.t - win, to: point.t + win, limit: 500 });
      const found = messageForPoint(res.messages, chartField, point, win);
      if (found) setSelectedMessage(found);
      else toast.info('No message found', 'Nothing recorded around that point carries the field.');
    } catch (err) {
      toast.error('Could not load the message', errorMessage(err));
    }
  };

  // Where the message on screen sits in the chart, so both directions match:
  // click a point to see its payload, and see the payload's point marked.
  const chartMarker = (() => {
    if (!chartField || !display) return null;
    const v = extractNumber(display.payload, chartField);
    return v === null ? null : { t: display.timestamp, v };
  })();

  const segments = subject.split('.');
  // A bookmark note belongs next to the subject it describes.
  const note = findBookmark(bookmarks, subject)?.note;
  const header = (
    <PaneHeader className="h-auto py-2 items-start">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-md text-fg break-all leading-snug">
          {segments.map((seg, i) => (
            <span key={`${i}-${seg}`}>
              <span className={i === segments.length - 1 ? 'font-semibold' : ''}>{seg}</span>
              {i < segments.length - 1 && <span className="text-faint mx-px">.</span>}
            </span>
          ))}
          {isBranch && <span className="text-faint">.&gt;</span>}
        </div>
        {note && <div className="text-xs text-muted mt-1 whitespace-pre-wrap break-words max-w-[70ch]">{note}</div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-muted">
          {isBranch ? (
            <span>{formatCount(branchMessages.length)} recent messages below this subject</span>
          ) : (
            <>
              <span>
                {formatCount(shownMessages.length)} {range ? `in ${range.label}` : 'in history'}
              </span>
              {!range && rate > 0 && <span className="text-warn">{rate < 10 ? rate.toFixed(1) : Math.round(rate)} msg/s</span>}
              {latest && <span>last {formatTime(latest.timestamp)}</span>}
              {latest && <span>{formatBytes(latest.size)}</span>}
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {subject && <BookmarkButton subject={subject} />}
        {canWrite && (
          <IconButton label={isBranch ? `Clear the history of ${subject} and everything below it` : `Clear the history of ${subject}`} onClick={clearThis}>
            <Eraser size={14} />
          </IconButton>
        )}
        <HistorySearchInput search={search} />
        <ExportMenu messages={isBranch ? shownBelow : shownMessages} name={range ? `${subject}-${range.label}` : subject} subject={subject} />
        <IconButton label="Copy subject" onClick={copySubject}>
          {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
        </IconButton>
        <Button
          variant="outline"
          icon={<Send size={13} />}
          onClick={() => prefillPublish({ subject: isBranch ? `${subject}.` : subject, payload: display ? prettyJson(display.payload) : undefined })}
        >
          Publish here
        </Button>
      </div>
    </PaneHeader>
  );

  const rangeBar = historyDb ? (
    <div className="shrink-0 px-3 py-1.5 border-b border-line flex items-center gap-3">
      <RangePicker range={range} onChange={setRange} />
      {range && (
        <span className="ml-auto text-xs text-muted">
          {ranged.loading && !ranged.data ? (
            'Loading…'
          ) : ranged.error ? (
            <span className="text-danger">{ranged.error}</span>
          ) : (
            `${formatCount(ranged.data?.messages.length ?? 0)} messages, ${range.label}`
          )}
        </span>
      )}
    </div>
  ) : null;

  // Search results replace the list or the payload while a query is active.
  if (search.results !== null) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {header}
        <SearchSummary search={search} />
        <MessageList
          className="flex-1 min-h-0"
          messages={search.results}
          // Across all subjects the full subject is the point of the row.
          subjectPrefix={search.scoped ? subject : ''}
          onOpen={s => s !== subject && revealSubject(s)}
          onSelect={setListMessage}
          selected={listMessage}
          onLoadOlder={search.loadMore}
          loadingOlder={search.loadingMore}
          atOldest={!search.more}
        />
        {listMessage && (
          <MessagePanel
            message={listMessage}
            onClose={() => setListMessage(null)}
            onOpenSubject={listMessage.subject === subject ? undefined : revealSubject}
          />
        )}
        <PublishDrawer />
      </div>
    );
  }

  if (isBranch) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {header}
        {rangeBar}
        <MessageList
          className="flex-1 min-h-0"
          messages={shownBelow}
          subjectPrefix={subject}
          onOpen={revealSubject}
          onSelect={setListMessage}
          selected={listMessage}
          // A time range brings its own messages; that list grows with the rail.
          onLoadOlder={range ? loadOlderRange : () => loadOlderBranch(subject)}
          loadingOlder={range ? loadingOlderRange : !!view?.loadingOlderBranch}
          atOldest={range ? !rangedData?.more : !!view?.branchAtOldest}
        />
        {listMessage && <MessagePanel message={listMessage} onClose={() => setListMessage(null)} onOpenSubject={revealSubject} />}
        <div className="shrink-0 px-4 py-2 text-xs text-faint flex items-center gap-1.5 border-t border-line">
          <FolderTree size={12} /> Showing {formatCount(shownBelow.length)} messages below <span className="font-mono">{subject}</span>
          {range ? ` in the last ${range.label}` : ', newest first'}. Click a row to see the message, "Open subject" to go there.
        </div>
        <PublishDrawer />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {header}
      {rangeBar}

      <div className="flex-1 min-h-0 flex">
        {showHistory && shownMessages.length > 1 && (
          <>
            <HistoryRail
              messages={shownMessages}
              active={display}
              width={railWidth}
              onPick={m => setSelectedMessage(m === latest ? null : m)}
              onLoadOlder={range ? loadOlderRange : () => loadOlder(subject)}
              loadingOlder={range ? loadingOlderRange : !!view?.loadingOlder}
              atOldest={range ? !rangedData?.more : !!view?.atOldest}
            />
            <ResizeHandle
              label="history"
              width={railWidth}
              onChange={setRailWidth}
              min={HISTORY_RAIL_WIDTH[0]}
              max={HISTORY_RAIL_WIDTH[1]}
              reset={HISTORY_RAIL_WIDTH[2]}
            />
          </>
        )}

        <div className="flex-1 min-w-0 min-h-0 overflow-auto p-4 flex flex-col gap-4">
          {!display ? (
            (range ? ranged.loading : view?.loading) ? (
              <EmptyState compact title="Loading history…" />
            ) : (range ? ranged.error : view?.error) ? (
              <EmptyState compact title="History unavailable" description={(range ? ranged.error : view?.error) ?? undefined} />
            ) : range ? (
              <EmptyState compact title="Nothing recorded in this range" description={`No message on this subject between the bounds of ${range.label}.`} />
            ) : (
              <EmptyState compact title="Waiting for a message on this subject" />
            )
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" active={showHistory} icon={<History size={13} />} onClick={() => setShowHistory(!showHistory)}>
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
                  <ValueChart messages={shownMessages} series={series} fieldPath={chartField} onPick={pickPoint} marker={chartMarker} />
                </div>
              )}

              <TrendStrip messages={shownMessages} latest={display} selected={chartField} onSelect={f => setChartField(c => (c === f ? null : f))} />

              <PayloadViewer
                payload={display.payload}
                type={display.payloadType}
                subject={display.subject}
                size={display.size}
                onFieldSelect={p => setChartField(f => (f === p ? null : p))}
                selectedField={chartField}
                maxHeight={showDiff ? 320 : undefined}
              />

              {subject && <SchemaPanel subject={subject} range={range} />}

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
                <span>
                  received {new Date(display.timestamp).toLocaleString()}.{String(display.timestamp % 1000).padStart(3, '0')}
                </span>
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

      <PublishDrawer />
    </div>
  );
}
