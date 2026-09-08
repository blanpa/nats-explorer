import { useState } from 'react';
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { getSchema, type SchemaDrift, type SchemaField } from '../../lib/api.schema';
import { useAsync } from '../../lib/useAsync';
import { cn, formatNumber, readSetting, writeSetting } from '../../lib/utils';
import { Badge } from '../ui/misc';
import { describeDrift, describeKinds, driftByPath, formatPresence, formatRange, isOptional, orphanDrift, typeTone } from './schema';

const OPEN_KEY = 'ne.schemaOpen';
const REFRESH_MS = 10_000;
const SAMPLE_LIMIT = 200;

function DriftBadge({ drift }: { drift: SchemaDrift }) {
  return (
    <Badge tone="warn" title={describeDrift(drift)}>
      <TriangleAlert size={10} /> {drift.kind === 'type-changed' ? 'type' : drift.kind === 'field-gone' ? 'gone' : 'new'}
    </Badge>
  );
}

function FieldRow({ field, drift }: { field: SchemaField; drift?: SchemaDrift }) {
  const range = formatRange(field);
  return (
    <tr>
      <td className="font-mono max-w-[280px] truncate" title={field.path}>
        {field.path}
        {isOptional(field) && (
          <span className="text-faint ml-1" title="Missing from some messages">
            ?
          </span>
        )}
      </td>
      <td>
        <span className="flex items-center gap-1 flex-wrap">
          {field.types.map(t => (
            <Badge key={t.type} tone={typeTone(t.type)} mono title={`${formatNumber(t.count)} messages`}>
              {t.type}
              {field.types.length > 1 && <span className="opacity-60"> {formatNumber(t.count)}</span>}
            </Badge>
          ))}
          {drift && <DriftBadge drift={drift} />}
        </span>
      </td>
      <td className={cn('num', isOptional(field) ? 'text-warn' : 'text-muted')}>{formatPresence(field.presence)}</td>
      <td className="font-mono text-muted max-w-[200px] truncate" title={range}>
        {range || <span className="text-faint">–</span>}
      </td>
      <td className="font-mono text-faint max-w-[220px] truncate" title={field.example}>
        {field.example}
      </td>
    </tr>
  );
}

/**
 * The structure of a subject's payloads, derived from the recorded messages:
 * which fields exist, their types, how often they appear, and whether the
 * newer messages look different from the older ones. Nobody maintains a
 * schema; a device that changes its output shows up here as drift.
 */
export default function SchemaPanel({ subject, connId, range }: { subject: string; connId?: string; range?: { from: number; to: number } | null }) {
  const [open, setOpen] = useState(() => readSetting(OPEN_KEY, false));
  const { data, error, initial } = useAsync(
    () => (open && subject ? getSchema(subject, { connId, limit: SAMPLE_LIMIT, from: range?.from, to: range?.to }) : null),
    [subject, connId, open, range?.from, range?.to],
    {
      key: open ? `schema:${connId ?? ''}:${subject}:${range?.from ?? 'live'}` : undefined,
      // A closed range does not change, so it is read once.
      interval: open && !range ? REFRESH_MS : undefined,
    },
  );

  const schema = data?.schema;
  const drift = schema ? driftByPath(schema.drift) : new Map<string, SchemaDrift>();
  const orphans = schema ? orphanDrift(schema) : [];
  const jsonSamples = schema?.kinds.json ?? 0;

  const toggle = () => {
    writeSetting(OPEN_KEY, !open);
    setOpen(!open);
  };

  return (
    <div className="card">
      <button type="button" className="w-full flex items-center gap-1.5 h-8 px-3 text-xs text-muted hover:text-fg" onClick={toggle} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="section-title">Schema</span>
        {schema && schema.drift.length > 0 && (
          <Badge tone="warn" title={`${schema.drift.length} field(s) changed between the older and the newer half`}>
            <TriangleAlert size={10} /> drift
          </Badge>
        )}
        {open && schema && <span className="ml-auto tabular-nums text-faint shrink-0">{describeKinds(schema)}</span>}
        {!open && <span className="ml-auto text-faint shrink-0">Fields, types and drift of this subject</span>}
      </button>

      {open && (
        <div className="border-t border-line">
          {error ? (
            <p className="text-xs text-danger px-3 py-2">{error}</p>
          ) : initial ? (
            <p className="text-xs text-faint px-3 py-2">Reading the recorded messages…</p>
          ) : !schema || schema.samples === 0 ? (
            <p className="text-xs text-muted px-3 py-2">No messages recorded for this subject yet.</p>
          ) : jsonSamples === 0 ? (
            <p className="text-xs text-muted px-3 py-2">The payloads on this subject are not JSON, so there is no field structure to derive.</p>
          ) : (
            <>
              <div className="overflow-auto max-h-80">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th className="num">Present</th>
                      <th>Range</th>
                      <th>Example</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schema.fields.map(f => (
                      <FieldRow key={f.path} field={f} drift={drift.get(f.path)} />
                    ))}
                    {orphans.map(d => (
                      <tr key={d.path}>
                        <td className="font-mono text-muted line-through max-w-[280px] truncate" title={d.path}>
                          {d.path}
                        </td>
                        <td colSpan={4}>
                          <span className="flex items-center gap-2">
                            <DriftBadge drift={d} />
                            <span className="text-xs text-muted">{describeDrift(d)}</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-faint border-t border-line">
                <span>
                  from {formatNumber(jsonSamples)} message{jsonSamples === 1 ? '' : 's'}
                </span>
                {schema.drift.length > 0 && <span className="text-warn ml-auto">{schema.drift.length} change(s) between the older and the newer half</span>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
