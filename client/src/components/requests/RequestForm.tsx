import { useState, type ReactNode } from 'react';
import { Braces, Plus, Send, Trash2 } from 'lucide-react';
import type { RequestReply, RunResult } from 'shared';
import { api, errorMessage } from '../../lib/api';
import type { RequestDraft } from '../../lib/savedRequests';
import { useStore } from '../../store';
import { cn, formatDurationMs, formatNumber, previewPayload, prettyJson, tryParseJson } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Input, Select, Textarea } from '../ui/Input';
import { Kbd, Segmented, StatStrip, StatTile } from '../ui/misc';
import PayloadViewer from '../subjects/PayloadViewer';

export const MAX_COUNT = 10_000;

/** Sends one request/publish or a repeated run and keeps the outcome. */
export function useRequestRunner() {
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<RequestReply | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setReply(null);
    setRun(null);
    setError(null);
  };

  const send = async (draft: RequestDraft, connId: string) => {
    if (!draft.subject.trim() || busy) return;
    setBusy(true);
    clear();
    const hdrs: Record<string, string[]> = {};
    for (const h of draft.headers) {
      const k = h.key.trim();
      if (k) (hdrs[k] ||= []).push(h.value);
    }
    const body = { subject: draft.subject.trim(), payload: draft.payload, headers: Object.keys(hdrs).length ? hdrs : undefined };
    try {
      if (draft.count > 1) {
        setRun(await api.run(connId, { ...body, mode: draft.mode, count: Math.min(MAX_COUNT, draft.count), concurrency: draft.concurrency, intervalMs: draft.intervalMs, timeout: draft.timeout }));
      } else if (draft.mode === 'request') {
        setReply(await api.requestReply(connId, { ...body, timeout: draft.timeout }));
      } else {
        await api.publish(connId, body);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return { busy, reply, run, error, send, clear };
}

/** Picks the connection a form sends through: explicit choice, else the active one, else any connected. */
export function useSendConnection(chosen: string) {
  const activeConnId = useStore(s => s.activeConnId);
  const connections = useStore(s => s.connections);
  const connected = connections.filter(c => c.connected);
  const effective = connected.find(c => c.id === chosen)?.id ?? connected.find(c => c.id === activeConnId)?.id ?? connected[0]?.id ?? null;
  return { connected, effective };
}

interface FormProps {
  draft: RequestDraft;
  onChange: (next: RequestDraft) => void;
  onSend: () => void;
  busy: boolean;
  canSend: boolean;
  connId: string;
  onConnChange: (id: string) => void;
  /** rendered right before the send button */
  toolbarExtra?: ReactNode;
  payloadRows?: number;
  subjectPlaceholder?: string;
}

export function RequestForm({ draft, onChange, onSend, busy, canSend, connId, onConnChange, toolbarExtra, payloadRows = 4, subjectPlaceholder }: FormProps) {
  const { connected } = useSendConnection(connId);
  const patch = (p: Partial<RequestDraft>) => onChange({ ...draft, ...p });
  const trimmed = draft.payload.trim();
  const jsonValid = trimmed === '' || (!trimmed.startsWith('{') && !trimmed.startsWith('[')) || tryParseJson(draft.payload) !== undefined;
  const repeated = draft.count > 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={draft.mode}
          onChange={mode => patch({ mode })}
          options={[
            { id: 'publish', label: 'Publish' },
            { id: 'request', label: 'Request / Reply' },
          ]}
        />
        {connected.length > 1 && (
          <Select inputSize="sm" className="w-44" value={connId} onChange={e => onConnChange(e.target.value)} aria-label="Connection">
            {connected.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        {draft.mode === 'request' && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Timeout
            <Input inputSize="sm" type="number" min={100} step={100} className="w-20" value={draft.timeout} onChange={e => patch({ timeout: Number(e.target.value) || 5000 })} />
            ms
          </label>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted" title="Send the message this many times. Use {{i}}, {{ts}}, {{uuid}} or {{rand:1-100}} in subject, payload or headers.">
          Repeat
          <Input inputSize="sm" type="number" min={1} max={MAX_COUNT} className="w-20" value={draft.count} onChange={e => patch({ count: Math.max(1, Math.min(MAX_COUNT, Math.floor(Number(e.target.value) || 1))) })} aria-label="Repeat count" />
          ×
        </label>
        {repeated && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-muted" title="Parallel senders">
              Parallel
              <Input inputSize="sm" type="number" min={1} max={64} className="w-16" value={draft.concurrency} onChange={e => patch({ concurrency: Math.max(1, Math.min(64, Math.floor(Number(e.target.value) || 1))) })} aria-label="Concurrency" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted" title="Pause between sends per parallel sender">
              Every
              <Input inputSize="sm" type="number" min={0} step={10} className="w-20" value={draft.intervalMs} onChange={e => patch({ intervalMs: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} aria-label="Interval" />
              ms
            </label>
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {toolbarExtra}
          <span className="text-xs text-faint hidden md:flex items-center gap-1">
            <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
          </span>
          <Button variant="primary" icon={<Send size={13} />} loading={busy} disabled={!canSend || !draft.subject.trim()} onClick={onSend} title={canSend ? undefined : 'Connect to a server to send'}>
            {repeated ? `Run ${formatNumber(draft.count)}×` : draft.mode === 'request' ? 'Send request' : 'Publish'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3">
        <div className="flex flex-col gap-2">
          <Input mono inputSize="sm" value={draft.subject} onChange={e => patch({ subject: e.target.value })} placeholder={subjectPlaceholder ?? 'subject.to.publish'} aria-label="Subject" />
          <div className="flex flex-col gap-1">
            {draft.headers.map((h, i) => (
              <div key={i} className="flex gap-1">
                <Input inputSize="sm" mono placeholder="Header" value={h.key} onChange={e => patch({ headers: draft.headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} />
                <Input inputSize="sm" mono placeholder="Value" value={h.value} onChange={e => patch({ headers: draft.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <IconButton label="Remove header" size="sm" onClick={() => patch({ headers: draft.headers.filter((_, j) => j !== i) })}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
            <Button size="xs" variant="ghost" icon={<Plus size={12} />} className="self-start" onClick={() => patch({ headers: [...draft.headers, { key: '', value: '' }] })}>
              Header
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <Textarea
            rows={payloadRows}
            value={draft.payload}
            onChange={e => patch({ payload: e.target.value })}
            placeholder='{"hello": "world"}'
            aria-label="Payload"
            className={!jsonValid ? 'border-warn/60' : undefined}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (canSend) onSend();
              }
            }}
          />
          <div className="flex items-center gap-2 text-xs">
            {!jsonValid ? (
              <span className="text-warn">Looks like JSON but does not parse. It will be sent as-is.</span>
            ) : (
              <span className="text-faint font-mono" title="Replaced per message in subject, payload and headers">
                {'{{i}} {{ts}} {{uuid}} {{rand:1-100}}'}
              </span>
            )}
            <span className="flex-1" />
            <span className="text-faint font-mono">{new TextEncoder().encode(draft.payload).length} B</span>
            <Button size="xs" variant="ghost" icon={<Braces size={12} />} disabled={tryParseJson(draft.payload) === undefined} onClick={() => patch({ payload: prettyJson(draft.payload) })}>
              Format
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function RequestResult({ error, run, reply }: { error: string | null; run: RunResult | null; reply: RequestReply | null }) {
  return (
    <>
      {error && <div className="text-sm text-danger font-mono rounded border border-danger/30 bg-danger/5 px-3 py-2">{error}</div>}
      {run && <RunSummary run={run} />}
      {reply && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="section-title">Reply</span>
            <span className="font-mono">{reply.subject}</span>
            <span className="font-mono">{formatDurationMs(reply.durationMs)}</span>
            <span className="font-mono">{reply.size} B</span>
          </div>
          {reply.headers && Object.keys(reply.headers).length > 0 && (
            <div className="text-xs font-mono text-muted">
              {Object.entries(reply.headers).map(([k, v]) => (
                <div key={k}>
                  <span className="text-syn-key">{k}</span>: {v.join(', ')}
                </div>
              ))}
            </div>
          )}
          <PayloadViewer compact payload={reply.payload} type={reply.payloadType} size={reply.size} maxHeight={320} />
        </div>
      )}
    </>
  );
}

function RunSummary({ run }: { run: RunResult }) {
  const errorKinds = Object.entries(run.errorCounts).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-col gap-2">
      <StatStrip className="text-xs">
        <StatTile label="Sent" value={formatNumber(run.sent)} sub={run.stopped ? 'stopped at time limit' : undefined} tone={run.stopped ? 'warn' : undefined} />
        <StatTile label="OK" value={formatNumber(run.ok)} tone={run.ok === run.sent ? 'ok' : undefined} />
        <StatTile label="Errors" value={formatNumber(run.errors)} tone={run.errors > 0 ? 'danger' : undefined} />
        <StatTile label="Duration" value={formatDurationMs(run.durationMs)} />
        <StatTile label={run.mode === 'request' ? 'Req/s' : 'Msg/s'} value={formatNumber(Math.round(run.perSecond))} />
        {run.latency && (
          <>
            <StatTile label="Latency p50" value={formatDurationMs(run.latency.p50)} />
            <StatTile label="p95" value={formatDurationMs(run.latency.p95)} />
            <StatTile label="max" value={formatDurationMs(run.latency.max)} sub={`min ${formatDurationMs(run.latency.min)}`} />
          </>
        )}
      </StatStrip>
      {errorKinds.length > 0 && (
        <div className="text-xs font-mono text-danger flex flex-col gap-0.5">
          {errorKinds.map(([msg, n]) => (
            <div key={msg}>
              {formatNumber(n)}× {msg}
            </div>
          ))}
        </div>
      )}
      {run.replies.length > 0 && (
        <div className="flex flex-col">
          <span className="section-title mb-1">First replies</span>
          {run.replies.map(r => {
            const p = previewPayload(r.payload, r.payloadType, 120);
            return (
              <div key={r.i} className="flex items-center gap-3 text-xs font-mono py-0.5 border-b border-line/60 last:border-b-0">
                <span className="text-faint w-10 text-right shrink-0">#{r.i}</span>
                <span className={cn('truncate', p.tone === 'num' ? 'text-syn-num' : p.tone === 'str' ? 'text-syn-str' : 'text-fg/90')}>{p.text}</span>
                <span className="ml-auto text-muted shrink-0">{formatDurationMs(r.durationMs)}</span>
                <span className="text-faint shrink-0">{r.size} B</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
