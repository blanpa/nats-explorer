import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, FileCode2, WrapText } from 'lucide-react';
import type { PayloadType } from 'shared';
import { cn, copyToClipboard, formatBytes, hexDump, payloadBytes, prettyJson, tryParseJson } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Segmented } from '../ui/misc';
import { type Decoded, decodeWith, findRule, useDecoders } from '../../lib/decoders';
import { markupOf, prettyXml, toBase64, wrapBase64 } from '../../lib/payloadFormat';
import { countFields, decodeRaw } from '../../lib/protoRaw';
import DecoderDialog from './DecoderDialog';
import { JsonTree } from './JsonTree';

type ViewMode = 'auto' | 'raw' | 'hex' | 'base64' | 'markup' | 'decoded' | 'fields';

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
  const bytes = useMemo(() => (mode === 'hex' || mode === 'base64' ? payloadBytes(payload, type) : null), [mode, payload, type]);
  // A payload that is markup is offered as itself: XML and HTML are read by
  // their structure, and one line of minified tags is not that.
  const markup = useMemo(() => (type === 'string' ? markupOf(payload) : null), [payload, type]);
  // Protobuf without its .proto: the field numbers are in the bytes, and
  // reading them is better than reading nothing while the schema is hunted.
  const fields = useMemo(() => (type === 'binary' && payload.length <= MAX_TREE_BYTES ? decodeRaw(payloadBytes(payload, type)) : null), [payload, type]);

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
    const text =
      mode === 'base64' && bytes
        ? toBase64(bytes)
        : mode === 'markup'
          ? prettyXml(payload)
          : type === 'binary'
            ? payload
            : mode === 'auto' && parsed !== undefined
              ? prettyJson(payload)
              : payload;
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
  } else if (mode === 'fields' && fields) {
    body = (
      <div className="flex flex-col gap-2 min-w-0">
        <p className="text-xs text-faint">
          No schema: these are the {countFields(fields)} fields in the bytes, by number. A length-delimited field reads as text where it is printable and as a
          nested message otherwise, and a 64-bit field as a double where that is a number someone would write down — the wire format does not say which was
          meant.
        </p>
        <div className="jv">
          <JsonTree data={fields} onFieldSelect={onFieldSelect} selectedFields={selectedFields ?? []} />
        </div>
      </div>
    );
  } else if (mode === 'base64') {
    // The bytes as base64, wrapped: this is the form that survives a paste
    // into a terminal, a ticket or another tool.
    body = <pre className="font-mono text-xs leading-[1.6] text-muted whitespace-pre-wrap break-all">{bytes ? wrapBase64(toBase64(bytes)) : ''}</pre>;
  } else if (mode === 'markup') {
    // Source, never rendered: a payload is someone else's text, and this
    // window is not the place to run it.
    body = (
      <pre className={cn('font-mono text-sm leading-[1.55] text-fg', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>{prettyXml(payload)}</pre>
    );
  } else if (mode === 'raw' || type === 'binary' || parsed === undefined) {
    if (type === 'binary' && mode !== 'raw') {
      body = (
        <div className="text-sm text-muted">
          Binary payload · {formatBytes(size ?? payloadBytes(payload, type).length)}. Switch to{' '}
          <button type="button" className="text-accent" onClick={() => setMode('hex')}>
            hex
          </button>{' '}
          to inspect the bytes
          {fields ? (
            <>
              , or to{' '}
              <button type="button" className="text-accent" onClick={() => setMode('fields')}>
                fields
              </button>{' '}
              to read the protobuf message behind them without its schema
            </>
          ) : null}
          .
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
    // With a maxHeight the viewer fills a box someone else measured, so it
    // may shrink. Without one it stands in a column that scrolls, and there
    // it must not: a flex child that can collapse will, and the payload gets
    // squeezed to a line while the charts above it take the room.
    <div className={cn('flex flex-col', maxHeight ? 'min-h-0' : 'shrink-0', className)}>
      <div className={cn('flex items-center gap-2', compact ? 'mb-1' : 'mb-2')}>
        <Segmented
          size="xs"
          value={mode}
          onChange={setMode}
          options={[
            { id: 'auto', label: type === 'json' ? 'JSON' : type === 'binary' ? 'Binary' : 'Text' },
            ...(rule ? [{ id: 'decoded' as const, label: 'Decoded' }] : []),
            // The wire shape, offered whenever the bytes are a protobuf
            // message at all -- with a rule as well, because "what did the
            // device actually send" is a different question from "what does
            // the schema make of it".
            ...(fields ? [{ id: 'fields' as const, label: 'Fields' }] : []),
            // Only ever one of the two: a payload is XML or it is HTML.
            ...(markup ? [{ id: 'markup' as const, label: markup === 'xml' ? 'XML' : 'HTML' }] : []),
            { id: 'raw', label: 'Raw' },
            { id: 'hex', label: 'Hex' },
            { id: 'base64', label: 'Base64' },
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
      <div className={cn('code-block overflow-auto', maxHeight ? 'flex-1 min-h-0' : 'min-h-40')} style={{ maxHeight }}>
        {body}
      </div>
    </div>
  );
}
