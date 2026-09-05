import { useMemo, useState } from 'react';
import { Check, Copy, WrapText } from 'lucide-react';
import type { PayloadType } from 'shared';
import { cn, copyToClipboard, formatBytes, hexDump, payloadBytes, prettyJson, tryParseJson } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Segmented } from '../ui/misc';
import { JsonTree } from './JsonTree';

type ViewMode = 'auto' | 'raw' | 'hex';

const MAX_TREE_BYTES = 256 * 1024;

interface Props {
  payload: string;
  type: PayloadType;
  size?: number;
  onFieldSelect?: (path: string) => void;
  selectedField?: string | null;
  /** max height of the scroll area; defaults to filling the parent */
  maxHeight?: number;
  compact?: boolean;
  className?: string;
}

export default function PayloadViewer({ payload, type, size, onFieldSelect, selectedField, maxHeight, compact, className }: Props) {
  const [mode, setMode] = useState<ViewMode>('auto');
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => (type === 'json' && payload.length <= MAX_TREE_BYTES ? tryParseJson(payload) : undefined), [payload, type]);
  const bytes = useMemo(() => (mode === 'hex' ? payloadBytes(payload, type) : null), [mode, payload, type]);

  const copy = async () => {
    const text = type === 'binary' ? payload : mode === 'auto' && parsed !== undefined ? prettyJson(payload) : payload;
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  let body: React.ReactNode;
  if (mode === 'hex') {
    body = <pre className="font-mono text-xs leading-[1.6] text-muted whitespace-pre">{bytes ? hexDump(bytes) : ''}</pre>;
  } else if (mode === 'raw' || type === 'binary' || parsed === undefined) {
    if (type === 'binary' && mode !== 'raw') {
      body = (
        <div className="text-sm text-muted">
          Binary payload · {formatBytes(size ?? payloadBytes(payload, type).length)}. Switch to <button className="text-accent" onClick={() => setMode('hex')}>hex</button> to inspect the bytes.
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
        <JsonTree data={parsed} onFieldSelect={onFieldSelect} selectedField={selectedField ?? null} />
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
            { id: 'raw', label: 'Raw' },
            { id: 'hex', label: 'Hex' },
          ]}
        />
        {type === 'json' && payload.length > MAX_TREE_BYTES && <span className="text-xs text-faint">large payload, tree view disabled</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label={wrap ? 'Disable line wrap' : 'Wrap lines'} size="xs" active={wrap} onClick={() => setWrap(w => !w)}>
            <WrapText size={13} />
          </IconButton>
          <IconButton label="Copy payload" size="xs" onClick={copy}>
            {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
          </IconButton>
        </div>
      </div>
      <div className="code-block flex-1 min-h-0 overflow-auto" style={{ maxHeight }}>
        {body}
      </div>
    </div>
  );
}
