import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Plus, RefreshCw, Trash2, Edit3, Save, X } from 'lucide-react';

export default function KvBucketView() {
  const activeConnId = useStore(s => s.activeConnId);
  const [bucketName, setBucketName] = useState<string | null>(null);
  const [keys, setKeys] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [entry, setEntry] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [showPut, setShowPut] = useState(false);
  const [putKey, setPutKey] = useState('');
  const [putValue, setPutValue] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [editValue, setEditValue] = useState('');

  useEffect(() => {
    const unsub = useStore.subscribe((state: any) => {
      if (state._selectedKvBucket !== bucketName) {
        setBucketName(state._selectedKvBucket || null);
        setSelectedKey(null);
        setEntry(null);
      }
    });
    const initial = (useStore.getState() as any)._selectedKvBucket;
    if (initial) setBucketName(initial);
    return unsub;
  }, []);

  useEffect(() => {
    if (bucketName) loadKeys();
  }, [bucketName, activeConnId]);

  useEffect(() => {
    if (bucketName && selectedKey) loadEntry();
  }, [selectedKey]);

  const loadKeys = async () => {
    if (!bucketName || !activeConnId) return;
    setLoading(true);
    try {
      const data = await api.listKvKeys(activeConnId, bucketName);
      setKeys(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadEntry = async () => {
    if (!bucketName || !selectedKey || !activeConnId) return;
    try {
      const data = await api.getKvEntry(activeConnId, bucketName, selectedKey);
      setEntry(data);
    } catch (err) {
      console.error(err);
    }
  };

  const handlePut = async () => {
    if (!bucketName || !putKey || !activeConnId) return;
    try {
      await api.putKvEntry(activeConnId, bucketName, putKey, putValue);
      setShowPut(false);
      setPutKey('');
      setPutValue('');
      loadKeys();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleUpdate = async () => {
    if (!bucketName || !selectedKey || !activeConnId) return;
    try {
      await api.putKvEntry(activeConnId, bucketName, selectedKey, editValue);
      setEditMode(false);
      loadEntry();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (key: string) => {
    if (!bucketName || !activeConnId || !confirm(`Delete key ${key}?`)) return;
    try {
      await api.deleteKvEntry(activeConnId, bucketName, key);
      if (selectedKey === key) { setSelectedKey(null); setEntry(null); }
      loadKeys();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (!bucketName) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Select a KV bucket to browse keys
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center justify-between">
        <h2 className="font-medium text-sm">KV: {bucketName}</h2>
        <div className="flex gap-1">
          <button onClick={loadKeys} className="p-1 hover:bg-accent rounded"><RefreshCw size={14} /></button>
          <button onClick={() => setShowPut(!showPut)} className="p-1 hover:bg-accent rounded"><Plus size={14} /></button>
        </div>
      </div>

      {showPut && (
        <div className="px-4 py-2 border-b border-border bg-muted space-y-2">
          <input value={putKey} onChange={e => setPutKey(e.target.value)} placeholder="Key" className="w-full px-2 py-1 bg-background border border-input rounded text-xs font-mono" />
          <textarea value={putValue} onChange={e => setPutValue(e.target.value)} placeholder="Value" rows={3} className="w-full px-2 py-1 bg-background border border-input rounded text-xs font-mono" />
          <button onClick={handlePut} disabled={!putKey} className="px-3 py-1 bg-primary text-primary-foreground text-xs rounded disabled:opacity-50">Put</button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="w-1/3 border-r border-border overflow-auto">
          {keys.map(key => (
            <div
              key={key}
              onClick={() => setSelectedKey(key)}
              className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-accent border-b border-border flex items-center justify-between group ${
                selectedKey === key ? 'bg-accent' : ''
              }`}
            >
              <span className="font-mono truncate">{key}</span>
              <button onClick={(e) => { e.stopPropagation(); handleDelete(key); }} className="p-0.5 hover:bg-destructive/20 rounded text-destructive opacity-0 group-hover:opacity-100">
                <Trash2 size={10} />
              </button>
            </div>
          ))}
          {keys.length === 0 && !loading && <div className="p-4 text-xs text-muted-foreground text-center">No keys</div>}
        </div>

        <div className="flex-1 overflow-auto p-4">
          {entry ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-sm font-medium">{entry.key}</h3>
                <div className="flex gap-1">
                  {!editMode ? (
                    <button onClick={() => { setEditMode(true); setEditValue(entry.value); }} className="p-1 hover:bg-accent rounded"><Edit3 size={14} /></button>
                  ) : (
                    <>
                      <button onClick={handleUpdate} className="p-1 hover:bg-accent rounded text-green-500"><Save size={14} /></button>
                      <button onClick={() => setEditMode(false)} className="p-1 hover:bg-accent rounded"><X size={14} /></button>
                    </>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div><span className="text-muted-foreground">Revision:</span> {entry.revision}</div>
                <div><span className="text-muted-foreground">Created:</span> {new Date(entry.created).toLocaleString()}</div>
              </div>
              {editMode ? (
                <textarea value={editValue} onChange={e => setEditValue(e.target.value)} rows={10} className="w-full px-3 py-2 bg-background border border-input rounded-md text-xs font-mono" />
              ) : (
                <pre className="bg-muted rounded-md p-3 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-64">
                  {(() => { try { return JSON.stringify(JSON.parse(entry.value), null, 2); } catch { return entry.value; } })()}
                </pre>
              )}
              {entry.history && entry.history.length > 1 && (
                <div>
                  <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2">History</h4>
                  <div className="space-y-1">
                    {entry.history.map((h: any, i: number) => (
                      <div key={i} className="bg-muted rounded p-2 text-xs">
                        <div className="flex justify-between text-muted-foreground">
                          <span>Rev: {h.revision}</span>
                          <span>{h.operation}</span>
                          <span>{new Date(h.created).toLocaleString()}</span>
                        </div>
                        <pre className="font-mono mt-1 whitespace-pre-wrap">{h.value?.substring(0, 200)}</pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              Select a key to view its value
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
