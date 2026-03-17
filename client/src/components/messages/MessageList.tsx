import { useEffect, useRef } from 'react';
import { useStore, NatsMessage } from '../../store';
import { formatBytes } from '../../lib/utils';

export default function MessageList({ messages }: { messages: NatsMessage[] }) {
  const { selectedMessage, setSelectedMessage } = useStore();
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length]);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  if (messages.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground text-xs">
        Waiting for messages...
      </div>
    );
  }

  return (
    <div ref={listRef} onScroll={handleScroll} className="overflow-auto h-full">
      {messages.map((msg, i) => {
        const isSelected = selectedMessage === msg;
        const time = new Date(msg.timestamp);
        return (
          <div
            key={`${msg.timestamp}-${i}`}
            onClick={() => setSelectedMessage(msg)}
            className={`px-3 py-1.5 border-b border-border cursor-pointer hover:bg-accent text-xs ${
              isSelected ? 'bg-accent' : ''
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-muted-foreground">
                {time.toLocaleTimeString()}.{time.getMilliseconds().toString().padStart(3, '0')}
              </span>
              <span className="text-muted-foreground">{formatBytes(msg.size)}</span>
            </div>
            <div className="truncate mt-0.5 text-foreground">
              {msg.payloadType === 'json' ? (
                <span className="text-green-400">{msg.payload.substring(0, 100)}</span>
              ) : msg.payloadType === 'binary' ? (
                <span className="text-yellow-400">[binary]</span>
              ) : (
                msg.payload.substring(0, 100)
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
