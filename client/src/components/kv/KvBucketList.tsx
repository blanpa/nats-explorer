import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { formatBytes, formatNumber } from '../../lib/utils';
import { Plus, RefreshCw, KeyRound, Trash2 } from 'lucide-react';

export default function KvBucketList() {
  const activeConnId = useStore(s => s.activeConnId);
  const [buckets, setBuckets] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newBucket, setNewBucket] = useState('');
  const [newHistory, setNewHistory] = useState('1');

  const loadBuckets = async () => {
    if (!activeConnId) return;
    setLoading(true);
    try {
      const data = await api.listKvBuckets(activeConnId);
      setBuckets(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadBuckets(); }, [activeConnId]);

  useEffect(() => {
    useStore.setState({ _selectedKvBucket: selectedBucket } as any);
  }, [selectedBucket]);

  const handleCreate = async () => {
    if (!newBucket || !activeConnId) return;
    try {
      await api.createKvBucket(activeConnId, { bucket: newBucket, history: parseInt(newHistory) || 1 });
      setShowCreate(false);
      setNewBucket('');
      loadBuckets();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (bucket: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeConnId || !confirm(`Delete KV bucket ${bucket}?`)) return;
    try {
      await api.deleteKvBucket(activeConnId, bucket);
      if (selectedBucket === bucket) setSelectedBucket(null);
      loadBuckets();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="p-2 space-y-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">KV Buckets</span>
        <div className="flex gap-1">
          <button onClick={loadBuckets} className="p-1 hover:bg-accent rounded"><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /></button>
          <button onClick={() => setShowCreate(!showCreate)} className="p-1 hover:bg-accent rounded"><Plus size={12} /></button>
        </div>
      </div>

      {showCreate && (
        <div className="bg-muted rounded p-2 space-y-2 mb-2">
          <input value={newBucket} onChange={e => setNewBucket(e.target.value)} placeholder="Bucket name" className="w-full px-2 py-1 bg-background border border-input rounded text-xs" />
          <input type="number" value={newHistory} onChange={e => setNewHistory(e.target.value)} placeholder="History" className="w-full px-2 py-1 bg-background border border-input rounded text-xs" />
          <button onClick={handleCreate} disabled={!newBucket} className="px-3 py-1 bg-primary text-primary-foreground text-xs rounded disabled:opacity-50">Create</button>
        </div>
      )}

      {buckets.map(bucket => (
        <div
          key={bucket.bucket}
          onClick={() => setSelectedBucket(bucket.bucket === selectedBucket ? null : bucket.bucket)}
          className={`p-2 rounded cursor-pointer text-xs hover:bg-accent group ${
            selectedBucket === bucket.bucket ? 'bg-accent' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <KeyRound size={12} className="text-primary flex-shrink-0" />
            <span className="font-medium truncate flex-1">{bucket.bucket}</span>
            <button onClick={(e) => handleDelete(bucket.bucket, e)} className="p-1 hover:bg-destructive/20 rounded text-destructive opacity-0 group-hover:opacity-100">
              <Trash2 size={10} />
            </button>
          </div>
          <div className="flex gap-3 mt-1 text-muted-foreground ml-5">
            <span>{formatNumber(bucket.values)} keys</span>
            <span>{formatBytes(bucket.bytes)}</span>
          </div>
        </div>
      ))}

      {buckets.length === 0 && !loading && (
        <div className="text-xs text-muted-foreground text-center py-4">No KV buckets found</div>
      )}
    </div>
  );
}
