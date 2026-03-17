import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Plus, Trash2, RefreshCw } from 'lucide-react';

export default function ConsumerList({ streamName }: { streamName: string }) {
  const activeConnId = useStore(s => s.activeConnId);
  const [consumers, setConsumers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFilter, setNewFilter] = useState('');
  const [newAckPolicy, setNewAckPolicy] = useState('explicit');

  const loadConsumers = async () => {
    if (!activeConnId) return;
    setLoading(true);
    try {
      const data = await api.listConsumers(activeConnId, streamName);
      setConsumers(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadConsumers(); }, [streamName, activeConnId]);

  const handleCreate = async () => {
    if (!newName || !activeConnId) return;
    try {
      await api.createConsumer(activeConnId, streamName, {
        durableName: newName,
        ackPolicy: newAckPolicy,
        filterSubject: newFilter || undefined,
      });
      setShowCreate(false);
      setNewName('');
      setNewFilter('');
      loadConsumers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (name: string) => {
    if (!activeConnId || !confirm(`Delete consumer ${name}?`)) return;
    try {
      await api.deleteConsumer(activeConnId, streamName, name);
      loadConsumers();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={loadConsumers} className="p-1 hover:bg-accent rounded"><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /></button>
        <button onClick={() => setShowCreate(!showCreate)} className="p-1 hover:bg-accent rounded"><Plus size={12} /></button>
      </div>

      {showCreate && (
        <div className="bg-muted rounded p-2 space-y-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Consumer name" className="w-full px-2 py-1 bg-background border border-input rounded text-xs" />
          <input value={newFilter} onChange={e => setNewFilter(e.target.value)} placeholder="Filter subject (optional)" className="w-full px-2 py-1 bg-background border border-input rounded text-xs font-mono" />
          <select value={newAckPolicy} onChange={e => setNewAckPolicy(e.target.value)} className="w-full px-2 py-1 bg-background border border-input rounded text-xs">
            <option value="explicit">Explicit</option>
            <option value="none">None</option>
            <option value="all">All</option>
          </select>
          <button onClick={handleCreate} disabled={!newName} className="px-3 py-1 bg-primary text-primary-foreground text-xs rounded disabled:opacity-50">Create</button>
        </div>
      )}

      {consumers.map(c => (
        <div key={c.name} className="bg-muted rounded p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium">{c.name}</span>
            <button onClick={() => handleDelete(c.name)} className="p-1 hover:bg-destructive/20 rounded text-destructive"><Trash2 size={12} /></button>
          </div>
          <div className="grid grid-cols-2 gap-1 mt-1 text-muted-foreground">
            <span>Ack Policy: {c.config.ackPolicy}</span>
            <span>Pending: {c.numAckPending}</span>
            {c.config.filterSubject && <span>Filter: {c.config.filterSubject}</span>}
            <span>Waiting: {c.numWaiting}</span>
          </div>
        </div>
      ))}

      {consumers.length === 0 && !loading && <div className="text-xs text-muted-foreground">No consumers</div>}
    </div>
  );
}
