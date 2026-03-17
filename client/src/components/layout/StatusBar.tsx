import { useStore } from '../../store';
import { formatNumber } from '../../lib/utils';

export default function StatusBar() {
  const { connections, activeConnId, totalMessages, messagesPerSecond, totalSubjects } = useStore();
  const activeConn = connections.find(c => c.id === activeConnId);
  const connectedCount = connections.filter(c => c.connected).length;

  return (
    <div className="status-bar">
      <div className="status-item">
        <span className={`status-dot ${connectedCount > 0 ? 'status-dot-on' : 'status-dot-off'}`} />
        <span>
          {connectedCount > 0
            ? `${connectedCount} connection${connectedCount > 1 ? 's' : ''}`
            : 'Disconnected'}
          {activeConn && ` | Active: ${activeConn.name}`}
        </span>
      </div>
      {connectedCount > 0 && (
        <>
          <div className="status-separator" />
          <div className="status-item">{formatNumber(totalMessages)} messages</div>
          <div className="status-separator" />
          <div className="status-item">{messagesPerSecond} msgs/s</div>
          <div className="status-separator" />
          <div className="status-item">{totalSubjects} subjects</div>
        </>
      )}
    </div>
  );
}
