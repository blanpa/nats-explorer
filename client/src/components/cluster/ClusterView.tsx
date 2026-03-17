import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { RefreshCw } from 'lucide-react';
import { formatBytes } from '../../lib/utils';

export default function ClusterView() {
  const { connections, activeConnId } = useStore();
  const [clusterInfos, setClusterInfos] = useState<Map<string, any>>(new Map());
  const [loading, setLoading] = useState(false);

  const loadClusterInfo = async () => {
    setLoading(true);
    const infos = new Map<string, any>();
    for (const conn of connections.filter(c => c.connected)) {
      try {
        const info = await api.getClusterInfo(conn.id);
        infos.set(conn.id, info);
      } catch {}
    }
    setClusterInfos(infos);
    setLoading(false);
  };

  useEffect(() => {
    if (connections.some(c => c.connected)) loadClusterInfo();
  }, [connections.length]);

  return (
    <div className="cluster-view">
      <div className="cluster-header">
        <span className="cluster-title">Server Info</span>
        <button onClick={loadClusterInfo} className="cluster-refresh">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {connections.filter(c => c.connected).map(conn => {
        const info = clusterInfos.get(conn.id);
        if (!info) return null;

        return (
          <div key={conn.id} className={`cluster-server ${activeConnId === conn.id ? 'cluster-server-active' : ''}`}>
            <div className="cluster-server-header" style={{ borderLeftColor: conn.color }}>
              <span className="cluster-server-name">{conn.name}</span>
              <span className="cluster-server-version">v{info.version}</span>
            </div>

            <div className="cluster-details">
              <div className="cluster-detail-row">
                <span className="cluster-detail-label">Server Name</span>
                <span className="cluster-detail-value">{info.serverName}</span>
              </div>
              <div className="cluster-detail-row">
                <span className="cluster-detail-label">Server ID</span>
                <span className="cluster-detail-value cluster-detail-mono">{info.serverId?.substring(0, 20)}...</span>
              </div>
              <div className="cluster-detail-row">
                <span className="cluster-detail-label">Address</span>
                <span className="cluster-detail-value">{info.host}:{info.port}</span>
              </div>
              <div className="cluster-detail-row">
                <span className="cluster-detail-label">Max Payload</span>
                <span className="cluster-detail-value">{formatBytes(info.maxPayload || 0)}</span>
              </div>
              <div className="cluster-detail-row">
                <span className="cluster-detail-label">JetStream</span>
                <span className="cluster-detail-value">{info.jetstream ? 'Enabled' : 'Disabled'}</span>
              </div>
              <div className="cluster-detail-row">
                <span className="cluster-detail-label">Auth Required</span>
                <span className="cluster-detail-value">{info.authRequired ? 'Yes' : 'No'}</span>
              </div>
              <div className="cluster-detail-row">
                <span className="cluster-detail-label">TLS Required</span>
                <span className="cluster-detail-value">{info.tlsRequired ? 'Yes' : 'No'}</span>
              </div>
              <div className="cluster-detail-row">
                <span className="cluster-detail-label">Client ID</span>
                <span className="cluster-detail-value">{info.clientId}</span>
              </div>
              {info.cluster && (
                <div className="cluster-detail-row">
                  <span className="cluster-detail-label">Cluster</span>
                  <span className="cluster-detail-value">{info.cluster}</span>
                </div>
              )}
            </div>

            {info.connectUrls && info.connectUrls.length > 0 && (
              <div className="cluster-nodes">
                <div className="cluster-nodes-title">Cluster Nodes ({info.connectUrls.length})</div>
                {info.connectUrls.map((url: string, i: number) => (
                  <div key={i} className="cluster-node-item">
                    <span className="cluster-node-dot" />
                    <span className="cluster-node-url">{url}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {connections.filter(c => c.connected).length === 0 && (
        <div className="cluster-empty">No active connections</div>
      )}
    </div>
  );
}
