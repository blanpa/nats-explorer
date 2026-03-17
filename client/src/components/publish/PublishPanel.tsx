import { useState } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';

export default function PublishPanel() {
  const selectedSubject = useStore(s => s.selectedSubject);
  const activeConnId = useStore(s => s.activeConnId);
  const connections = useStore(s => s.connections);
  const [subject, setSubject] = useState('');
  const [payload, setPayload] = useState('');
  const [isRequest, setIsRequest] = useState(false);
  const [selectedConnId, setSelectedConnId] = useState('');
  const [response, setResponse] = useState<any>(null);
  const [error, setError] = useState('');
  const [showHeaders, setShowHeaders] = useState(false);
  const [headerPairs, setHeaderPairs] = useState<{key: string, value: string}[]>([]);

  const effectiveSubject = subject || selectedSubject || '';
  const effectiveConnId = selectedConnId || activeConnId;
  const connectedConns = connections.filter(c => c.connected);

  const handleSend = async () => {
    if (!effectiveSubject || !effectiveConnId) return;
    setError(''); setResponse(null);
    const headers: Record<string, string[]> = {};
    for (const pair of headerPairs) {
      if (pair.key.trim()) {
        if (!headers[pair.key.trim()]) headers[pair.key.trim()] = [];
        headers[pair.key.trim()].push(pair.value);
      }
    }
    const hasHeaders = Object.keys(headers).length > 0;
    try {
      if (isRequest) {
        const res = await api.requestReply(effectiveConnId, { subject: effectiveSubject, payload, timeout: 5000 });
        setResponse(res);
      } else {
        await api.publish(effectiveConnId, { subject: effectiveSubject, payload, ...(hasHeaders ? { headers } : {}) });
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="publish-panel">
      <div className="publish-header">
        <span className="publish-title">Publish</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {connectedConns.length > 1 && (
            <select
              value={selectedConnId || activeConnId || ''}
              onChange={e => setSelectedConnId(e.target.value)}
              className="publish-input"
              style={{ width: 120, fontSize: 11, padding: '2px 4px' }}
            >
              {connectedConns.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <label className="publish-toggle">
            <input type="checkbox" checked={isRequest} onChange={e => setIsRequest(e.target.checked)} />
            <span>Request/Reply</span>
          </label>
        </div>
      </div>
      <div className="publish-fields">
        <div className="publish-field">
          <label className="publish-label">Subject</label>
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder={selectedSubject || 'my.subject'} className="publish-input" />
        </div>
        <div className="publish-field">
          <label className="publish-label">Message</label>
          <textarea value={payload} onChange={e => setPayload(e.target.value)} placeholder='{"key": "value"}' className="publish-textarea" rows={3} onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleSend(); }} />
        </div>
        <div className="publish-field">
          <label className="publish-toggle" style={{ marginBottom: 2 }}>
            <input type="checkbox" checked={showHeaders} onChange={e => setShowHeaders(e.target.checked)} />
            <span>Headers</span>
          </label>
          {showHeaders && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {headerPairs.map((pair, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    value={pair.key}
                    onChange={e => {
                      const updated = [...headerPairs];
                      updated[i] = { ...updated[i], key: e.target.value };
                      setHeaderPairs(updated);
                    }}
                    placeholder="Header key"
                    className="publish-input"
                    style={{ flex: 1 }}
                  />
                  <input
                    value={pair.value}
                    onChange={e => {
                      const updated = [...headerPairs];
                      updated[i] = { ...updated[i], value: e.target.value };
                      setHeaderPairs(updated);
                    }}
                    placeholder="Value"
                    className="publish-input"
                    style={{ flex: 1 }}
                  />
                  <button
                    onClick={() => setHeaderPairs(headerPairs.filter((_, j) => j !== i))}
                    className="connpanel-item-btn connpanel-item-btn-del"
                    title="Remove header"
                    style={{ padding: 4 }}
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button
                onClick={() => setHeaderPairs([...headerPairs, { key: '', value: '' }])}
                className="conn-sub-add"
                style={{ marginTop: 2 }}
              >
                + Add Header
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="publish-actions">
        <button onClick={handleSend} disabled={!effectiveSubject || !effectiveConnId} className="publish-btn">
          {isRequest ? 'Send Request' : 'Publish'}
        </button>
        <span className="publish-hint">Ctrl+Enter to send</span>
      </div>
      {response && (
        <div className="publish-response">
          <span className="publish-response-label">Response:</span>
          <pre className="publish-response-body">{response.payloadType === 'json' ? JSON.stringify(JSON.parse(response.payload), null, 2) : response.payload}</pre>
        </div>
      )}
      {error && <div className="publish-error">{error}</div>}
    </div>
  );
}
