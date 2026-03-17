import { useState } from 'react';
import { useStore } from '../../store';
import PayloadViewer from './PayloadViewer';
import ValueChart from './ValueChart';
import { formatBytes } from '../../lib/utils';

export default function MessageView() {
  const { selectedSubject, messages, selectedMessage, setSelectedMessage } = useStore();
  const [showHistory, setShowHistory] = useState(false);
  const [chartField, setChartField] = useState<string | null>(null);

  if (!selectedSubject) {
    return (
      <div className="detail-empty">
        <p>Select a subject from the tree to view messages</p>
      </div>
    );
  }

  const subjectMessages = messages.get(selectedSubject) || [];
  const latestMessage = subjectMessages[subjectMessages.length - 1];
  const displayMessage = selectedMessage && selectedMessage.subject === selectedSubject ? selectedMessage : latestMessage;

  const handleFieldSelect = (path: string, _value: number) => {
    setChartField(chartField === path ? null : path);
  };

  return (
    <div className="detail-panel">
      {/* Topic Header */}
      <div className="detail-topic-header">
        <div className="detail-topic-path">
          {selectedSubject.split('.').map((segment, i, arr) => (
            <span key={i}>
              <span className="detail-topic-segment">{segment}</span>
              {i < arr.length - 1 && <span className="detail-topic-sep">.</span>}
            </span>
          ))}
        </div>
        <div className="detail-topic-meta">
          <span>{subjectMessages.length} messages</span>
          {latestMessage && (
            <>
              <span className="detail-meta-sep">|</span>
              <span>{formatBytes(latestMessage.size)}</span>
              <span className="detail-meta-sep">|</span>
              <span>Last: {new Date(latestMessage.timestamp).toLocaleTimeString()}</span>
            </>
          )}
        </div>
      </div>

      {/* Chart - shown when a numeric field is selected */}
      {chartField && subjectMessages.length > 0 && (
        <div className="detail-chart-section">
          <div className="detail-section-header">
            <span>Chart: {chartField}</span>
            <button onClick={() => setChartField(null)} className="detail-action-btn">Close</button>
          </div>
          <ValueChart messages={subjectMessages} fieldPath={chartField} />
        </div>
      )}

      {/* Current Value Display */}
      {displayMessage ? (
        <div className="detail-value-section">
          <div className="detail-section-header">
            <span>Value</span>
            <div className="detail-section-actions">
              <button
                onClick={() => setShowHistory(!showHistory)}
                className={`detail-action-btn ${showHistory ? 'detail-action-btn-active' : ''}`}
              >
                History ({subjectMessages.length})
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(displayMessage.payload)}
                className="detail-action-btn"
              >
                Copy
              </button>
            </div>
          </div>
          <PayloadViewer
            payload={displayMessage.payload}
            type={displayMessage.payloadType}
            onFieldSelect={handleFieldSelect}
            selectedField={chartField}
          />

          {/* Headers */}
          {displayMessage.headers && Object.keys(displayMessage.headers).length > 0 && (
            <div className="detail-headers">
              <div className="detail-section-header">Headers</div>
              <div className="detail-headers-table">
                {Object.entries(displayMessage.headers).map(([key, values]) => (
                  <div key={key} className="detail-header-row">
                    <span className="detail-header-key">{key}</span>
                    <span className="detail-header-value">{values.join(', ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Timestamp */}
          <div className="detail-timestamp">
            Received: {new Date(displayMessage.timestamp).toLocaleString()}.{new Date(displayMessage.timestamp).getMilliseconds().toString().padStart(3, '0')}
            {displayMessage.reply && <span> | Reply-To: <code>{displayMessage.reply}</code></span>}
          </div>
        </div>
      ) : (
        <div className="detail-empty-value">Waiting for messages on this subject...</div>
      )}

      {/* Message History */}
      {showHistory && (
        <div className="detail-history">
          <div className="detail-section-header">Message History</div>
          <div className="detail-history-list">
            {[...subjectMessages].reverse().map((msg, i) => (
              <div
                key={`${msg.timestamp}-${i}`}
                className={`detail-history-item ${displayMessage === msg ? 'detail-history-item-active' : ''}`}
                onClick={() => setSelectedMessage(msg)}
              >
                <span className="detail-history-time">
                  {new Date(msg.timestamp).toLocaleTimeString()}.{new Date(msg.timestamp).getMilliseconds().toString().padStart(3, '0')}
                </span>
                <span className="detail-history-preview">
                  {msg.payload.substring(0, 60)}
                </span>
                <span className="detail-history-size">{formatBytes(msg.size)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
