import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { formatBytes, formatNumber, formatAge } from '../../lib/utils';
import { Trash2, Eraser, RefreshCw, ChevronDown, ChevronRight, Users } from 'lucide-react';
import ConsumerList from './ConsumerList';

export default function StreamDetail() {
  const activeConnId = useStore(s => s.activeConnId);
  const [streamName, setStreamName] = useState<string | null>(null);
  const [stream, setStream] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showConsumers, setShowConsumers] = useState(false);
  const [showMessages, setShowMessages] = useState(false);

  // Subscribe to store changes for selected stream
  useEffect(() => {
    const unsub = useStore.subscribe((state: any) => {
      if (state._selectedStream !== streamName) {
        setStreamName(state._selectedStream || null);
      }
    });
    // Initial check
    const initial = (useStore.getState() as any)._selectedStream;
    if (initial) setStreamName(initial);
    return unsub;
  }, []);

  useEffect(() => {
    if (streamName) loadStream();
  }, [streamName, activeConnId]);

  const loadStream = async () => {
    if (!streamName || !activeConnId) return;
    setLoading(true);
    try {
      const data = await api.getStream(activeConnId, streamName);
      setStream(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async () => {
    if (!streamName || !activeConnId) return;
    try {
      const data: any = await api.getStreamMessages(activeConnId, streamName, undefined, 50);
      setMessages(data.messages || []);
    } catch (err) {
      console.error(err);
    }
  };

  const handlePurge = async () => {
    if (!streamName || !activeConnId || !confirm(`Purge all messages from ${streamName}?`)) return;
    try {
      await api.purgeStream(activeConnId, streamName);
      loadStream();
      setMessages([]);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async () => {
    if (!streamName || !activeConnId || !confirm(`Delete stream ${streamName}?`)) return;
    try {
      await api.deleteStream(activeConnId, streamName);
      setStreamName(null);
      setStream(null);
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (!streamName) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Select a stream to view details
      </div>
    );
  }

  if (loading && !stream) {
    return <div className="p-4 text-muted-foreground text-sm">Loading...</div>;
  }

  if (!stream) return null;

  return (
    <div className="p-4 space-y-4 overflow-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{stream.name}</h2>
        <div className="flex gap-2">
          <button onClick={loadStream} className="p-1.5 hover:bg-accent rounded" title="Refresh">
            <RefreshCw size={14} />
          </button>
          <button onClick={handlePurge} className="p-1.5 hover:bg-accent rounded text-yellow-500" title="Purge">
            <Eraser size={14} />
          </button>
          <button onClick={handleDelete} className="p-1.5 hover:bg-destructive/20 rounded text-destructive" title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {stream.description && <p className="text-sm text-muted-foreground">{stream.description}</p>}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Messages', value: formatNumber(stream.state.messages) },
          { label: 'Size', value: formatBytes(stream.state.bytes) },
          { label: 'Consumers', value: stream.state.consumerCount },
          { label: 'Subjects', value: stream.state.numSubjects || 0 },
          { label: 'First Seq', value: stream.state.firstSeq },
          { label: 'Last Seq', value: stream.state.lastSeq },
          { label: 'Deleted', value: stream.state.numDeleted || 0 },
        ].map(stat => (
          <div key={stat.label} className="bg-muted rounded-md p-2">
            <div className="text-xs text-muted-foreground">{stat.label}</div>
            <div className="text-sm font-medium">{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Config */}
      <div className="bg-muted rounded-md p-3">
        <h3 className="text-xs font-medium mb-2 text-muted-foreground uppercase">Configuration</h3>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div><span className="text-muted-foreground">Subjects:</span> <span className="font-mono">{stream.subjects?.join(', ')}</span></div>
          <div><span className="text-muted-foreground">Retention:</span> {stream.retention}</div>
          <div><span className="text-muted-foreground">Storage:</span> {stream.storage}</div>
          <div><span className="text-muted-foreground">Replicas:</span> {stream.replicas}</div>
          <div><span className="text-muted-foreground">Max Msgs:</span> {stream.maxMsgs === -1 ? 'unlimited' : formatNumber(stream.maxMsgs)}</div>
          <div><span className="text-muted-foreground">Max Bytes:</span> {stream.maxBytes === -1 ? 'unlimited' : formatBytes(stream.maxBytes)}</div>
          <div><span className="text-muted-foreground">Max Age:</span> {formatAge(stream.maxAge)}</div>
          <div><span className="text-muted-foreground">Discard:</span> {stream.discard}</div>
        </div>
      </div>

      {/* Consumers section */}
      <div>
        <button
          onClick={() => setShowConsumers(!showConsumers)}
          className="flex items-center gap-2 text-sm font-medium hover:text-primary"
        >
          {showConsumers ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Users size={14} />
          Consumers ({stream.state.consumerCount})
        </button>
        {showConsumers && <ConsumerList streamName={streamName} />}
      </div>

      {/* Messages section */}
      <div>
        <button
          onClick={() => { setShowMessages(!showMessages); if (!showMessages) loadMessages(); }}
          className="flex items-center gap-2 text-sm font-medium hover:text-primary"
        >
          {showMessages ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Messages
        </button>
        {showMessages && (
          <div className="mt-2 space-y-1">
            {messages.map(msg => (
              <div key={msg.seq} className="bg-muted rounded p-2 text-xs">
                <div className="flex justify-between text-muted-foreground mb-1">
                  <span>Seq: {msg.seq}</span>
                  <span>{msg.subject}</span>
                  <span>{new Date(msg.timestamp).toLocaleString()}</span>
                </div>
                <pre className="font-mono whitespace-pre-wrap">{
                  msg.payloadType === 'json' ? JSON.stringify(JSON.parse(msg.payload), null, 2) : msg.payload
                }</pre>
              </div>
            ))}
            {messages.length === 0 && <div className="text-xs text-muted-foreground">No messages</div>}
          </div>
        )}
      </div>
    </div>
  );
}
