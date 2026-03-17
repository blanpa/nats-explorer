import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { formatBytes } from '../../lib/utils';
import { Plus, RefreshCw, Archive } from 'lucide-react';

export default function ObjStoreList() {
  const activeConnId = useStore(s => s.activeConnId);
  const [stores, setStores] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedStore, setSelectedStore] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newStore, setNewStore] = useState('');

  const loadStores = async () => {
    if (!activeConnId) return;
    setLoading(true);
    try {
      const data = await api.listObjectStores(activeConnId);
      setStores(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStores(); }, [activeConnId]);

  useEffect(() => {
    useStore.setState({ _selectedObjStore: selectedStore } as any);
  }, [selectedStore]);

  const handleCreate = async () => {
    if (!newStore || !activeConnId) return;
    try {
      await api.createObjectStore(activeConnId, { bucket: newStore });
      setShowCreate(false);
      setNewStore('');
      loadStores();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="p-2 space-y-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">Object Stores</span>
        <div className="flex gap-1">
          <button onClick={loadStores} className="p-1 hover:bg-accent rounded"><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /></button>
          <button onClick={() => setShowCreate(!showCreate)} className="p-1 hover:bg-accent rounded"><Plus size={12} /></button>
        </div>
      </div>

      {showCreate && (
        <div className="bg-muted rounded p-2 space-y-2 mb-2">
          <input value={newStore} onChange={e => setNewStore(e.target.value)} placeholder="Store name" className="w-full px-2 py-1 bg-background border border-input rounded text-xs" />
          <button onClick={handleCreate} disabled={!newStore} className="px-3 py-1 bg-primary text-primary-foreground text-xs rounded disabled:opacity-50">Create</button>
        </div>
      )}

      {stores.map(store => (
        <div
          key={store.bucket}
          onClick={() => setSelectedStore(store.bucket === selectedStore ? null : store.bucket)}
          className={`p-2 rounded cursor-pointer text-xs hover:bg-accent ${
            selectedStore === store.bucket ? 'bg-accent' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <Archive size={12} className="text-primary flex-shrink-0" />
            <span className="font-medium truncate">{store.bucket}</span>
          </div>
          <div className="flex gap-3 mt-1 text-muted-foreground ml-5">
            <span>{formatBytes(store.size)}</span>
            <span>{store.chunks} chunks</span>
          </div>
        </div>
      ))}

      {stores.length === 0 && !loading && (
        <div className="text-xs text-muted-foreground text-center py-4">No object stores found</div>
      )}
    </div>
  );
}
