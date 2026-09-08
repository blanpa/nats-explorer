import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { StreamMessage } from 'shared';
import { cn, formatBytes, formatTime, previewPayload } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { SubjectText } from '../ui/SubjectText';
import { toneClass } from '../ui/tone';
import PayloadViewer from '../subjects/PayloadViewer';

interface Props {
  m: StreamMessage;
  open: boolean;
  /** arrived through the live tail rather than the page */
  live: boolean;
  canWrite: boolean;
  denyDelete: boolean;
  /** field currently charted, to highlight it in the payload tree */
  chartField: string | null;
  charting: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onFieldSelect: (field: string, subject: string) => void;
}

/** One stream message: the summary row and, when open, headers and payload below it. */
export default function StreamMessageRow({ m, open, live, canWrite, denyDelete, chartField, charting, onToggle, onDelete, onFieldSelect }: Props) {
  const p = previewPayload(m.payload, m.payloadType, 90);
  return (
    <>
      <tr className={cn('cursor-pointer', live && 'bg-ok/5')} onClick={onToggle}>
        <td className="text-faint">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
        <td className="num text-muted">{m.seq}</td>
        <td className="font-mono text-muted">{formatTime(m.timestamp)}</td>
        <td>
          <SubjectText subject={m.subject} />
        </td>
        <td className={cn('font-mono truncate', toneClass[p.tone])}>{p.text}</td>
        <td className="num text-muted">{formatBytes(m.size)}</td>
        <td>
          <IconButton
            label="Delete message"
            size="xs"
            hidden={!canWrite}
            disabled={denyDelete}
            onClick={e => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={12} className="text-danger" />
          </IconButton>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="whitespace-normal! bg-panel/60 py-3!">
            <div className="flex flex-col gap-3 max-w-[1100px]">
              {m.headers && Object.keys(m.headers).length > 0 && (
                <div className="text-xs font-mono">
                  {Object.entries(m.headers).map(([k, v]) => (
                    <div key={k}>
                      <span className="text-syn-key">{k}</span>
                      <span className="text-faint">: </span>
                      <span className="text-syn-str">{v.join(', ')}</span>
                    </div>
                  ))}
                </div>
              )}
              {m.payloadType === 'json' && !charting && <div className="text-xs text-faint">Click a number to chart it over the stream.</div>}
              <PayloadViewer
                compact
                subject={m.subject}
                payload={m.payload}
                type={m.payloadType}
                size={m.size}
                maxHeight={360}
                selectedField={chartField}
                onFieldSelect={field => onFieldSelect(field, m.subject)}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
