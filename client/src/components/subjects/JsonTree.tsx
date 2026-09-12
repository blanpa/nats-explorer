import { memo, useState } from 'react';
import { cn } from '../../lib/utils';

interface Props {
  data: unknown;
  depth?: number;
  path?: string;
  onFieldSelect?: (path: string) => void;
  /** the fields being charted; a selected one is marked */
  selectedFields: string[];
  /** collapse objects deeper than this by default */
  collapseDepth?: number;
}

const INDENT = 16;

export const JsonTree = memo(function JsonTree({ data, depth = 0, path = '', onFieldSelect, selectedFields, collapseDepth = 6 }: Props) {
  const [collapsed, setCollapsed] = useState(depth >= collapseDepth);

  if (data === null) return <span className="jv-null">null</span>;
  if (typeof data === 'boolean') return <span className="jv-bool">{String(data)}</span>;
  if (typeof data === 'number') {
    if (!onFieldSelect) return <span className="jv-num">{String(data)}</span>;
    const active = selectedFields.includes(path);
    return (
      <span
        className={cn('jv-num jv-chartable', active && 'jv-chartable-active')}
        title={active ? 'Stop charting this field' : `Chart "${path}" over time`}
        onClick={e => {
          e.stopPropagation();
          onFieldSelect(path);
        }}
      >
        {String(data)}
      </span>
    );
  }
  if (typeof data === 'string') return <span className="jv-str">"{data}"</span>;
  if (typeof data !== 'object') return <span className="jv-null">{String(data)}</span>;

  const isArray = Array.isArray(data);
  const entries: [string, unknown][] = isArray ? (data as unknown[]).map((v, i) => [String(i), v]) : Object.entries(data as Record<string, unknown>);
  const [open, close] = isArray ? ['[', ']'] : ['{', '}'];

  if (entries.length === 0)
    return (
      <span className="jv-punct">
        {open}
        {close}
      </span>
    );

  if (collapsed) {
    return (
      <span className="jv-toggle" onClick={() => setCollapsed(false)} title="Expand">
        <span className="jv-punct">{open}</span>
        <span className="text-faint italic text-xs mx-1">
          {entries.length} {isArray ? 'items' : 'keys'}
        </span>
        <span className="jv-punct">{close}</span>
      </span>
    );
  }

  return (
    <span>
      <span className="jv-punct jv-toggle" onClick={() => setCollapsed(true)} title="Collapse">
        {open}
      </span>
      {entries.map(([key, val], i) => {
        const childPath = path ? `${path}.${key}` : key;
        return (
          <div key={key} style={{ paddingLeft: INDENT }}>
            {!isArray && (
              <>
                <span className="jv-key">"{key}"</span>
                <span className="jv-punct">: </span>
              </>
            )}
            <JsonTree
              data={val}
              depth={depth + 1}
              path={childPath}
              onFieldSelect={onFieldSelect}
              selectedFields={selectedFields}
              collapseDepth={collapseDepth}
            />
            {i < entries.length - 1 && <span className="jv-punct">,</span>}
          </div>
        );
      })}
      <span className="jv-punct">{close}</span>
    </span>
  );
});
