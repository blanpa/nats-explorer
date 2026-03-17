import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { RefreshCw, Radio, Activity } from 'lucide-react';

export default function ServiceList() {
  const activeConnId = useStore(s => s.activeConnId);
  const [services, setServices] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadServices = async () => {
    if (!activeConnId) return;
    setLoading(true);
    try {
      const [svcData, statsData] = await Promise.allSettled([
        api.discoverServices(activeConnId),
        api.getServiceStats(activeConnId),
      ]);
      if (svcData.status === 'fulfilled') setServices(svcData.value);
      if (statsData.status === 'fulfilled') setStats(statsData.value);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadServices(); }, [activeConnId]);

  const getStatsForService = (name: string, id: string) => {
    return stats.find(s => s.name === name && s.id === id);
  };

  return (
    <div className="mon-dashboard">
      <div className="mon-toolbar">
        <span className="mon-toolbar-title">Services</span>
        <button onClick={loadServices} className="mon-refresh-btn" disabled={loading}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {services.length === 0 ? (
        <div className="mon-empty">
          <Radio size={24} style={{ opacity: 0.3 }} />
          <p>No services discovered</p>
          <p className="mon-error-hint">Services must use the NATS micro framework to be discoverable</p>
        </div>
      ) : (
        <div className="mon-grid mon-grid-1">
          {services.map((svc, i) => {
            const svcStats = getStatsForService(svc.name, svc.id);
            return (
              <div key={`${svc.id}-${i}`} className="mon-card">
                <div className="mon-card-header">
                  <Activity size={12} />
                  <span>{svc.name}</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 'normal', fontSize: 10, textTransform: 'none' }}>
                    v{svc.version}
                  </span>
                </div>
                <div className="mon-card-stats">
                  <div className="mon-stat">
                    <span className="mon-stat-label">ID</span>
                    <span className="mon-stat-value mon-stat-mono">{svc.id?.substring(0, 20)}...</span>
                  </div>
                  {svc.description && (
                    <div className="mon-stat">
                      <span className="mon-stat-label">Description</span>
                      <span className="mon-stat-value">{svc.description}</span>
                    </div>
                  )}
                  {svc.metadata && Object.keys(svc.metadata).length > 0 && (
                    <div className="mon-stat">
                      <span className="mon-stat-label">Metadata</span>
                      <span className="mon-stat-value mon-stat-mono">{JSON.stringify(svc.metadata)}</span>
                    </div>
                  )}
                  {svc.endpoints && svc.endpoints.length > 0 && (
                    <>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, marginBottom: 4, fontWeight: 600 }}>
                        Endpoints ({svc.endpoints.length})
                      </div>
                      {svc.endpoints.map((ep: any, j: number) => (
                        <div key={j} className="mon-stat" style={{ paddingLeft: 8 }}>
                          <span className="mon-stat-label">{ep.name}</span>
                          <span className="mon-stat-value mon-stat-mono">{ep.subject}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {svcStats && (
                    <>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, marginBottom: 4, fontWeight: 600 }}>
                        Stats
                      </div>
                      <div className="mon-stat">
                        <span className="mon-stat-label">Started</span>
                        <span className="mon-stat-value">{new Date(svcStats.started).toLocaleString()}</span>
                      </div>
                      {svcStats.endpoints && svcStats.endpoints.map((ep: any, j: number) => (
                        <div key={j} style={{ paddingLeft: 8, fontSize: 11 }}>
                          <div className="mon-stat">
                            <span className="mon-stat-label">{ep.name}</span>
                            <span className="mon-stat-value">{ep.num_requests || 0} reqs, {ep.num_errors || 0} errs, avg {ep.average_processing_time || '0'}ns</span>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
