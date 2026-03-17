import { useState } from 'react';

type ViewMode = 'auto' | 'raw' | 'hex';

interface Props {
  payload: string;
  type: string;
  onFieldSelect?: (path: string, value: number) => void;
  selectedField?: string | null;
}

export default function PayloadViewer({ payload, type, onFieldSelect, selectedField }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('auto');

  const renderAuto = () => {
    if (type === 'json') {
      try {
        const parsed = JSON.parse(payload);
        return (
          <div className="payload-json">
            <JsonTree data={parsed} onFieldSelect={onFieldSelect} selectedField={selectedField} />
          </div>
        );
      } catch {
        return <pre className="payload-raw">{payload}</pre>;
      }
    }
    if (type === 'binary') {
      return <span className="payload-binary">&lt;Binary data, {payload.length} bytes base64&gt;</span>;
    }
    return <pre className="payload-raw">{payload}</pre>;
  };

  const renderHex = () => {
    const bytes = type === 'binary' ? atob(payload) : payload;
    const lines: string[] = [];
    for (let i = 0; i < Math.min(bytes.length, 512); i += 16) {
      const hex = Array.from(bytes.slice(i, i + 16))
        .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(' ');
      const ascii = Array.from(bytes.slice(i, i + 16))
        .map(c => { const code = c.charCodeAt(0); return code >= 32 && code < 127 ? c : '.'; })
        .join('');
      lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(48)}  ${ascii}`);
    }
    return <pre className="payload-hex">{lines.join('\n')}</pre>;
  };

  return (
    <div className="payload-viewer">
      <div className="payload-tabs">
        {(['auto', 'raw', 'hex'] as ViewMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`payload-tab ${viewMode === mode ? 'payload-tab-active' : ''}`}
          >
            {mode === 'auto' ? 'Formatted' : mode === 'raw' ? 'Raw' : 'Hex'}
          </button>
        ))}
      </div>
      <div className="payload-content">
        {viewMode === 'auto' && renderAuto()}
        {viewMode === 'raw' && <pre className="payload-raw">{payload}</pre>}
        {viewMode === 'hex' && renderHex()}
      </div>
    </div>
  );
}

function JsonTree({
  data,
  depth = 0,
  path = '',
  onFieldSelect,
  selectedField,
}: {
  data: any;
  depth?: number;
  path?: string;
  onFieldSelect?: (path: string, value: number) => void;
  selectedField?: string | null;
}) {
  const [collapsed, setCollapsed] = useState(depth > 4);
  const indent = depth * 18;

  if (data === null) return <span className="jv-null">null</span>;
  if (typeof data === 'boolean') return <span className="jv-bool">{data.toString()}</span>;
  if (typeof data === 'number') {
    const isSelected = selectedField === path;
    return (
      <span
        className={`jv-num jv-num-clickable ${isSelected ? 'jv-num-selected' : ''}`}
        onClick={(e) => { e.stopPropagation(); onFieldSelect?.(path, data); }}
        title={`Click to chart "${path}"`}
      >
        {data}
        <span className="jv-chart-icon">{isSelected ? '\u2716' : '\u2197'}</span>
      </span>
    );
  }
  if (typeof data === 'string') return <span className="jv-str">"{data}"</span>;

  const isArray = Array.isArray(data);
  const entries = isArray ? data.map((v: any, i: number) => [i, v]) : Object.entries(data);
  const bracket = isArray ? ['[', ']'] : ['{', '}'];

  if (entries.length === 0) {
    return <span className="jv-bracket">{bracket[0]}{bracket[1]}</span>;
  }

  if (collapsed) {
    return (
      <span className="jv-collapsed" onClick={() => setCollapsed(false)}>
        {bracket[0]} <span className="jv-ellipsis">{entries.length} {isArray ? 'items' : 'keys'}...</span> {bracket[1]}
      </span>
    );
  }

  return (
    <span>
      <span className="jv-bracket jv-toggle" onClick={() => setCollapsed(true)}>{bracket[0]}</span>
      {entries.map((entry: any, i: number) => {
        const key = entry[0];
        const val = entry[1];
        const childPath = path ? `${path}.${key}` : String(key);
        return (
          <div key={key} style={{ paddingLeft: indent + 18 }} className="jv-line">
            {!isArray && <><span className="jv-key">"{key}"</span><span className="jv-colon">: </span></>}
            <JsonTree
              data={val}
              depth={depth + 1}
              path={childPath}
              onFieldSelect={onFieldSelect}
              selectedField={selectedField}
            />
            {i < entries.length - 1 && <span className="jv-comma">,</span>}
          </div>
        );
      })}
      <div style={{ paddingLeft: indent }}><span className="jv-bracket">{bracket[1]}</span></div>
    </span>
  );
}
