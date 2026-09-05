import { useEffect, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Braces, ChevronDown, History, Plus, Send, Trash2 } from 'lucide-react';
import type { RequestReply } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useStore } from '../../store';
import { formatDurationMs, prettyJson, tryParseJson } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Input, Select, Textarea } from '../ui/Input';
import { Kbd, Segmented } from '../ui/misc';
import { toast } from '../ui/Toast';
import PayloadViewer from './PayloadViewer';

type Mode = 'publish' | 'request';
interface HeaderPair {
  key: string;
  value: string;
}

interface RecentSend {
  mode: Mode;
  subject: string;
  payload: string;
  headers: HeaderPair[];
  ts: number;
}

const RECENT_KEY = 'ne.publishRecent';
const RECENT_MAX = 12;

function loadRecent(): RecentSend[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentSend[]) : [];
  } catch {
    return [];
  }
}

function pushRecent(item: RecentSend): RecentSend[] {
  const list = [item, ...loadRecent().filter(r => !(r.subject === item.subject && r.payload === item.payload && r.mode === item.mode))].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

export default function PublishPanel() {
  const selectedSubject = useStore(s => s.selectedSubject);
  const prefill = useStore(s => s.publishPrefill);
  const clearPrefill = useStore(s => s.prefillPublish);
  const activeConnId = useStore(s => s.activeConnId);
  const connections = useStore(s => s.connections);
  const connected = connections.filter(c => c.connected);

  const [mode, setMode] = useState<Mode>('publish');
  const [subject, setSubject] = useState(selectedSubject ?? '');
  const [payload, setPayload] = useState('');
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const [timeout, setTimeoutMs] = useState(5000);
  const [connId, setConnId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<RequestReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentSend[]>(loadRecent);

  useEffect(() => {
    if (prefill) {
      setSubject(prefill.subject);
      if (prefill.payload !== undefined) setPayload(prefill.payload);
      clearPrefill(null);
    }
  }, [prefill, clearPrefill]);

  const effectiveConn = connected.find(c => c.id === connId)?.id ?? activeConnId ?? connected[0]?.id ?? null;
  const jsonValid = payload.trim() === '' || !payload.trim().startsWith('{') && !payload.trim().startsWith('[') || tryParseJson(payload) !== undefined;

  const send = async () => {
    if (!subject.trim() || !effectiveConn) return;
    setBusy(true);
    setError(null);
    setReply(null);
    const hdrs: Record<string, string[]> = {};
    for (const h of headers) {
      const k = h.key.trim();
      if (!k) continue;
      (hdrs[k] ||= []).push(h.value);
    }
    const body = { subject: subject.trim(), payload, headers: Object.keys(hdrs).length ? hdrs : undefined };
    setRecent(pushRecent({ mode, subject: body.subject, payload, headers: headers.filter(h => h.key.trim()), ts: Date.now() }));
    try {
      if (mode === 'request') {
        const res = await api.requestReply(effectiveConn, { ...body, timeout });
        setReply(res);
      } else {
        await api.publish(effectiveConn, body);
        toast.success(`Published to ${body.subject}`);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { id: 'publish', label: 'Publish' },
            { id: 'request', label: 'Request / Reply' },
          ]}
        />
        {connected.length > 1 && (
          <Select inputSize="sm" className="w-44" value={effectiveConn ?? ''} onChange={e => setConnId(e.target.value)} aria-label="Connection">
            {connected.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        {mode === 'request' && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Timeout
            <Input inputSize="sm" type="number" min={100} step={100} className="w-24" value={timeout} onChange={e => setTimeoutMs(Number(e.target.value) || 5000)} />
            ms
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {recent.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button size="sm" variant="ghost" icon={<History size={13} />}>
                  Recent <ChevronDown size={12} />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-[420px] max-w-[calc(100vw-32px)] rounded-lg border border-line bg-panel shadow-pop p-1 animate-fade-in outline-none">
                  {recent.map((r, i) => (
                    <DropdownMenu.Item
                      key={i}
                      onSelect={() => {
                        setMode(r.mode);
                        setSubject(r.subject);
                        setPayload(r.payload);
                        setHeaders(r.headers);
                      }}
                      className="flex flex-col gap-0.5 px-2 py-1.5 rounded cursor-pointer outline-none data-[highlighted]:bg-field"
                    >
                      <span className="flex items-center gap-2 text-sm font-mono truncate">
                        <span className={r.mode === 'request' ? 'text-info' : 'text-accent'}>{r.mode === 'request' ? 'REQ' : 'PUB'}</span>
                        <span className="truncate">{r.subject}</span>
                      </span>
                      <span className="text-xs text-muted font-mono truncate">{r.payload.replace(/\s+/g, ' ').slice(0, 90) || '(empty payload)'}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          <span className="text-xs text-faint hidden md:flex items-center gap-1">
            <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> to send
          </span>
          <Button variant="primary" icon={<Send size={13} />} loading={busy} disabled={!subject.trim() || !effectiveConn} onClick={send}>
            {mode === 'request' ? 'Send request' : 'Publish'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3">
        <div className="flex flex-col gap-2">
          <Input mono inputSize="sm" value={subject} onChange={e => setSubject(e.target.value)} placeholder={selectedSubject ?? 'subject.to.publish'} aria-label="Subject" />
          <div className="flex flex-col gap-1">
            {headers.map((h, i) => (
              <div key={i} className="flex gap-1">
                <Input inputSize="sm" mono placeholder="Header" value={h.key} onChange={e => setHeaders(hs => hs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                <Input inputSize="sm" mono placeholder="Value" value={h.value} onChange={e => setHeaders(hs => hs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <IconButton label="Remove header" size="sm" onClick={() => setHeaders(hs => hs.filter((_, j) => j !== i))}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
            <Button size="xs" variant="ghost" icon={<Plus size={12} />} className="self-start" onClick={() => setHeaders(hs => [...hs, { key: '', value: '' }])}>
              Header
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1 min-w-0">
          <Textarea
            rows={4}
            value={payload}
            onChange={e => setPayload(e.target.value)}
            placeholder='{"hello": "world"}'
            aria-label="Payload"
            className={!jsonValid ? 'border-warn/60' : undefined}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="flex items-center gap-2 text-xs">
            {!jsonValid && <span className="text-warn">Looks like JSON but does not parse. It will be sent as-is.</span>}
            <span className="flex-1" />
            <span className="text-faint font-mono">{new TextEncoder().encode(payload).length} B</span>
            <Button size="xs" variant="ghost" icon={<Braces size={12} />} disabled={tryParseJson(payload) === undefined} onClick={() => setPayload(prettyJson(payload))}>
              Format
            </Button>
          </div>
        </div>
      </div>

      {error && <div className="text-sm text-danger font-mono rounded border border-danger/30 bg-danger/5 px-3 py-2">{error}</div>}

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
          <PayloadViewer compact payload={reply.payload} type={reply.payloadType} size={reply.size} maxHeight={240} />
        </div>
      )}
    </div>
  );
}
