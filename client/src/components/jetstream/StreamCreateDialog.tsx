import { useState } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { X, Loader2 } from 'lucide-react';

export default function StreamCreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const activeConnId = useStore(s => s.activeConnId);
  const [name, setName] = useState('');
  const [subjects, setSubjects] = useState('');
  const [retention, setRetention] = useState<'limits' | 'interest' | 'workqueue'>('limits');
  const [storage, setStorage] = useState<'file' | 'memory'>('file');
  const [maxMsgs, setMaxMsgs] = useState('');
  const [maxBytes, setMaxBytes] = useState('');
  const [maxAge, setMaxAge] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name || !subjects || !activeConnId) return;
    setLoading(true);
    setError('');
    try {
      await api.createStream(activeConnId, {
        name,
        subjects: subjects.split(',').map(s => s.trim()),
        retention,
        storage,
        maxMsgs: maxMsgs ? parseInt(maxMsgs) : undefined,
        maxBytes: maxBytes ? parseInt(maxBytes) : undefined,
        maxAge: maxAge ? parseInt(maxAge) * 1e9 : undefined,
      });
      onCreated();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg w-full max-w-md p-6 shadow-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Create Stream</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded"><X size={16} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Name</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-1.5 bg-background border border-input rounded-md text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Subjects (comma-separated)</label>
            <input value={subjects} onChange={e => setSubjects(e.target.value)} placeholder="orders.>" className="w-full px-3 py-1.5 bg-background border border-input rounded-md text-sm font-mono" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Retention</label>
              <select value={retention} onChange={e => setRetention(e.target.value as any)} className="w-full px-3 py-1.5 bg-background border border-input rounded-md text-sm">
                <option value="limits">Limits</option>
                <option value="interest">Interest</option>
                <option value="workqueue">Work Queue</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Storage</label>
              <select value={storage} onChange={e => setStorage(e.target.value as any)} className="w-full px-3 py-1.5 bg-background border border-input rounded-md text-sm">
                <option value="file">File</option>
                <option value="memory">Memory</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Max Msgs</label>
              <input type="number" value={maxMsgs} onChange={e => setMaxMsgs(e.target.value)} placeholder="-1" className="w-full px-3 py-1.5 bg-background border border-input rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Max Bytes</label>
              <input type="number" value={maxBytes} onChange={e => setMaxBytes(e.target.value)} placeholder="-1" className="w-full px-3 py-1.5 bg-background border border-input rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Max Age (s)</label>
              <input type="number" value={maxAge} onChange={e => setMaxAge(e.target.value)} placeholder="0" className="w-full px-3 py-1.5 bg-background border border-input rounded-md text-sm" />
            </div>
          </div>
          {error && <div className="text-destructive text-xs">{error}</div>}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-md hover:bg-accent">Cancel</button>
            <button onClick={handleCreate} disabled={loading || !name || !subjects} className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2">
              {loading && <Loader2 size={14} className="animate-spin" />}
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
