import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { formatBytes, formatNumber, formatAge } from '../../lib/utils';
import { Plus, RefreshCw, Database } from 'lucide-react';
import StreamCreateDialog from './StreamCreateDialog';

interface StreamInfo {
  name: string;
  subjects: string[];
  retention: string;
  storage: string;
  state: {
    messages: number;
    bytes: number;
    consumerCount: number;
  };
}

export default function StreamList() {
  const activeConnId = useStore(s => s.activeConnId);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedStream, setSelectedStream] = useState<string | null>(null);

  const loadStreams = async () => {
    if (!activeConnId) return;
    setLoading(true);
    try {
      const data = await api.listStreams(activeConnId) as StreamInfo[];
      setStreams(data);
    } catch (err) {
      console.error('Failed to load streams:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStreams();
  }, [activeConnId]);

  // Store selected stream for detail view
  useEffect(() => {
    useStore.setState({ _selectedStream: selectedStream } as any);
  }, [selectedStream]);

  return (
    <div className="p-2 space-y-1">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground uppercase">Streams</span>
        <div className="flex gap-1">
          <button onClick={loadStreams} className="p-1 hover:bg-accent rounded" title="Refresh">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={() => setShowCreate(true)} className="p-1 hover:bg-accent rounded" title="Create Stream">
            <Plus size={12} />
          </button>
        </div>
      </div>

      {streams.length === 0 && !loading && (
        <div className="text-xs text-muted-foreground text-center py-4">
          No streams found
        </div>
      )}

      {streams.map(stream => (
        <div
          key={stream.name}
          onClick={() => setSelectedStream(stream.name === selectedStream ? null : stream.name)}
          className={`p-2 rounded cursor-pointer text-xs hover:bg-accent ${
            selectedStream === stream.name ? 'bg-accent' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <Database size={12} className="text-primary flex-shrink-0" />
            <span className="font-medium truncate">{stream.name}</span>
          </div>
          <div className="flex gap-3 mt-1 text-muted-foreground ml-5">
            <span>{formatNumber(stream.state.messages)} msgs</span>
            <span>{formatBytes(stream.state.bytes)}</span>
            <span>{stream.state.consumerCount} consumers</span>
          </div>
        </div>
      ))}

      {showCreate && (
        <StreamCreateDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadStreams(); }}
        />
      )}
    </div>
  );
}
