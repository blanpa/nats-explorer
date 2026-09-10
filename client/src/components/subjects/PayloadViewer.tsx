import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, FileCode2, WrapText } from 'lucide-react';
import type { PayloadType } from 'shared';
import { cn, copyToClipboard, formatBytes, hexDump, payloadBytes, prettyJson, tryParseJson } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Segmented } from '../ui/misc';
import { type Decoded, decodeWith, findRule, useDecoders } from '../../lib/decoders';
import DecoderDialog from './DecoderDialog';
import { JsonTree } from './JsonTree';

type ViewMode = 'auto' | 'raw' | 'hex' | 'decoded';

const MAX_TREE_BYTES = 256 * 1024;

interface Props {
  payload: string;
  type: PayloadType;
  /** enables the decoder rules for this subject */
  subject?: string;
  size?: number;
  onFieldSelect?: (path: string) => void;
  selectedFields?: string[];
  /** max height of the scroll area; defaults to filling the parent */
  maxHeight?: number;
  compact?: boolean;
  className?: string;
}

export default function PayloadViewer({ payload, type, subject, size, onFieldSelect, selectedFields, maxHeight, compact, className }: Props) {
  const [mode, setMode] = useState<ViewMode>('auto');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => (type === 'json' && payload.length <= MAX_TREE_BYTES ? tryParseJson(payload) : undefined), [payload, type]);
  const bytes = useMemo(() => (mode === 'hex' ? payloadBytes(payload, type) : null), [mode, payload, type]);

  // A decoder rule for the subject turns binary payloads into a tree; "auto" prefers it.
  const rules = useDecoders(s => s.rules);
  const rule = useMemo(() => (subject ? findRule(rules, subject) : undefined), [rules, subject]);
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  useEffect(() => {
    if (!rule) {
      setDecoded(null);
      return;
    }
    let live = true;
    decodeWith(rule, payloadBytes(payload, type)).then(res => live && setDecoded(res));
    return () => {
      live = false;
    };
  }, [rule, payload, type]);
  const showDecoded = !!rule && (mode === 'decoded' || (mode === 'auto' && type !== 'json'));

  const copy = async () => {
    const text = type === 'binary' ? payload : mode === 'auto' && parsed !== undefined ? prettyJson(payload) : payload;
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  let body: React.ReactNode;
  if (showDecoded) {
    body =
      decoded === null ? (
        <span className="text-sm text-faint">Decoding…</span>
      ) : decoded.ok ? (
        <div className="jv">
          <JsonTree data={decoded.value} onFieldSelect={onFieldSelect} selectedFields={selectedFields ?? []} />
        </div>
      ) : (
        <div className="text-sm text-danger">
          Could not decode as {rule?.format}: {decoded.error}
        </div>
      );
  } else if (mode === 'hex') {
    body = <pre className="font-mono text-xs leading-[1.6] text-muted whitespace-pre">{bytes ? hexDump(bytes) : ''}</pre>;
  } else if (mode === 'raw' || type === 'binary' || parsed === undefined) {
    if (type === 'binary' && mode !== 'raw') {
      body = (
        <div className="text-sm text-muted">
          Binary payload · {formatBytes(size ?? payloadBytes(payload, type).length)}. Switch to{' '}
          <button type="button" className="text-accent" onClick={() => setMode('hex')}>
            hex
          </button>{' '}
          to inspect the bytes.
        </div>
      );
    } else if (payload.length === 0) {
      body = <span className="text-sm text-faint italic">empty payload</span>;
    } else {
      body = <pre className={cn('font-mono text-sm leading-[1.55] text-fg', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>{payload}</pre>;
    }
  } else {
    body = (
      <div className="jv">
        <JsonTree data={parsed} onFieldSelect={onFieldSelect} selectedFields={selectedFields ?? []} />
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col min-h-0', className)}>
      <div className={cn('flex items-center gap-2', compact ? 'mb-1' : 'mb-2')}>
        <Segmented
          size="xs"
          value={mode}
          onChange={setMode}
          options={[
            { id: 'auto', label: type === 'json' ? 'JSON' : type === 'binary' ? 'Binary' : 'Text' },
            ...(rule ? [{ id: 'decoded' as const, label: 'Decoded' }] : []),
            { id: 'raw', label: 'Raw' },
            { id: 'hex', label: 'Hex' },
          ]}
        />
        {rule && <span className="text-xs text-faint font-mono truncate">{rule.pattern}</span>}
        {type === 'json' && payload.length > MAX_TREE_BYTES && <span className="text-xs text-faint">large payload, tree view disabled</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label={wrap ? 'Disable line wrap' : 'Wrap lines'} size="xs" active={wrap} onClick={() => setWrap(w => !w)}>
            <WrapText size={13} />
          </IconButton>
          <IconButton label="Copy payload" size="xs" onClick={copy}>
            {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
          </IconButton>
          {subject && (
            <IconButton
              label={rule ? 'Edit payload decoders' : 'Decode with a schema (MessagePack, protobuf, Avro)'}
              size="xs"
              active={!!rule}
              onClick={() => setRulesOpen(true)}
            >
              <FileCode2 size={13} />
            </IconButton>
          )}
        </div>
      </div>
      {subject && <DecoderDialog open={rulesOpen} onClose={() => setRulesOpen(false)} prefill={rule?.pattern ?? subject} />}
      <div className="code-block flex-1 min-h-0 overflow-auto" style={{ maxHeight }}>
        {body}
      </div>
    </div>
  );
}
