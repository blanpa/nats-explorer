import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { api } from '../../lib/api';
import { formatBytes, formatNumber } from '../../lib/utils';
import { RefreshCw, Activity, Server, Database, Users, Zap } from 'lucide-react';

export default function MonitoringDashboard() {
  const activeConnId = useStore(s => s.activeConnId);
  const [varz, setVarz] = useState<any>(null);
  const [jsz, setJsz] = useState<any>(null);
  const [connz, setConnz] = useState<any>(null);
  const [subsz, setSubsz] = useState<any>(null);
  const [healthz, setHealthz] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<any>(null);

  const loadAll = async () => {
    if (!activeConnId) return;
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled([
        api.getMonitoring(activeConnId, 'varz'),
        api.getMonitoring(activeConnId, 'jsz'),
        api.getMonitoring(activeConnId, 'connz'),
        api.getMonitoring(activeConnId, 'subsz'),
        api.getMonitoring(activeConnId, 'healthz'),
      ]);
      if (results[0].status === 'fulfilled') setVarz(results[0].value);
      if (results[1].status === 'fulfilled') setJsz(results[1].value);
      if (results[2].status === 'fulfilled') setConnz(results[2].value);
      if (results[3].status === 'fulfilled') setSubsz(results[3].value);
      if (results[4].status === 'fulfilled') setHealthz(results[4].value);
      // If all failed, show error
      if (results.every(r => r.status === 'rejected')) {
        setError((results[0] as any).reason?.message || 'Failed to fetch monitoring data');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [activeConnId]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(loadAll, 5000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, activeConnId]);

  if (!activeConnId) {
    return <div className="mon-empty">Select a connection to view monitoring data</div>;
  }

  if (error && !varz) {
    return (
      <div className="mon-empty">
        <p>Cannot fetch monitoring data</p>
        <p className="mon-error-detail">{error}</p>
        <p className="mon-error-hint">Set the monitoring port in connection settings (usually 8222)</p>
        <button onClick={loadAll} className="mon-retry-btn">Retry</button>
      </div>
    );
  }

  return (
    <div className="mon-dashboard">
      <div className="mon-toolbar">
        <span className="mon-toolbar-title">Server Monitoring</span>
        <label className="mon-auto-refresh">
          <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
          <span>Auto-refresh (5s)</span>
        </label>
        <button onClick={loadAll} className="mon-refresh-btn" disabled={loading}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Health + Server Info Row */}
      <div className="mon-grid mon-grid-3">
        {/* Health */}
        <div className="mon-card">
          <div className="mon-card-header"><Activity size={12} /> Health</div>
          <div className={`mon-health-status ${healthz?.status === 'ok' ? 'mon-health-ok' : 'mon-health-err'}`}>
            {healthz?.status === 'ok' ? 'HEALTHY' : 'UNKNOWN'}
          </div>
          {varz && (
            <div className="mon-card-stats">
              <div className="mon-stat"><span className="mon-stat-label">Version</span><span className="mon-stat-value">{varz.version}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Uptime</span><span className="mon-stat-value">{varz.uptime}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Server</span><span className="mon-stat-value mon-stat-mono">{varz.server_name?.substring(0, 12)}...</span></div>
            </div>
          )}
        </div>

        {/* System Resources */}
        <div className="mon-card">
          <div className="mon-card-header"><Server size={12} /> System</div>
          {varz && (
            <div className="mon-card-stats">
              <div className="mon-stat"><span className="mon-stat-label">CPU</span><span className="mon-stat-value">{(varz.cpu || 0).toFixed(1)}%</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Memory</span><span className="mon-stat-value">{formatBytes(varz.mem || 0)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Cores</span><span className="mon-stat-value">{varz.cores}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Go</span><span className="mon-stat-value">{varz.go}</span></div>
            </div>
          )}
        </div>

        {/* Connections */}
        <div className="mon-card">
          <div className="mon-card-header"><Users size={12} /> Connections</div>
          {varz && (
            <div className="mon-card-stats">
              <div className="mon-stat"><span className="mon-stat-label">Current</span><span className="mon-stat-value mon-stat-big">{varz.connections}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Total</span><span className="mon-stat-value">{formatNumber(varz.total_connections)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Subscriptions</span><span className="mon-stat-value">{formatNumber(varz.subscriptions)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Slow Consumers</span><span className={`mon-stat-value ${varz.slow_consumers > 0 ? 'mon-stat-warn' : ''}`}>{varz.slow_consumers}</span></div>
            </div>
          )}
        </div>
      </div>

      {/* Traffic Row */}
      <div className="mon-grid mon-grid-2">
        <div className="mon-card">
          <div className="mon-card-header"><Zap size={12} /> Messages</div>
          {varz && (
            <div className="mon-card-stats">
              <div className="mon-stat"><span className="mon-stat-label">In</span><span className="mon-stat-value">{formatNumber(varz.in_msgs)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Out</span><span className="mon-stat-value">{formatNumber(varz.out_msgs)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">In Bytes</span><span className="mon-stat-value">{formatBytes(varz.in_bytes)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Out Bytes</span><span className="mon-stat-value">{formatBytes(varz.out_bytes)}</span></div>
            </div>
          )}
        </div>

        {/* JetStream */}
        <div className="mon-card">
          <div className="mon-card-header"><Database size={12} /> JetStream</div>
          {jsz ? (
            <div className="mon-card-stats">
              <div className="mon-stat"><span className="mon-stat-label">Memory</span><span className="mon-stat-value">{formatBytes(jsz.memory)} / {formatBytes(jsz.config?.max_memory || 0)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Storage</span><span className="mon-stat-value">{formatBytes(jsz.storage)} / {formatBytes(jsz.config?.max_storage || 0)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Streams</span><span className="mon-stat-value">{jsz.streams || 0}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Consumers</span><span className="mon-stat-value">{jsz.consumers || 0}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">Messages</span><span className="mon-stat-value">{formatNumber(jsz.messages || 0)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">API Calls</span><span className="mon-stat-value">{formatNumber(jsz.api?.total || 0)}</span></div>
              <div className="mon-stat"><span className="mon-stat-label">API Errors</span><span className={`mon-stat-value ${(jsz.api?.errors || 0) > 0 ? 'mon-stat-warn' : ''}`}>{jsz.api?.errors || 0}</span></div>
            </div>
          ) : (
            <div className="mon-card-empty">JetStream not available</div>
          )}
        </div>
      </div>

      {/* Subscriptions */}
      {subsz && (
        <div className="mon-card">
          <div className="mon-card-header">Subscriptions</div>
          <div className="mon-card-stats mon-stats-horizontal">
            <div className="mon-stat"><span className="mon-stat-label">Total</span><span className="mon-stat-value">{formatNumber(subsz.num_subscriptions)}</span></div>
            <div className="mon-stat"><span className="mon-stat-label">Cache Hit</span><span className="mon-stat-value">{((subsz.cache_hit_rate || 0) * 100).toFixed(1)}%</span></div>
            <div className="mon-stat"><span className="mon-stat-label">Max Fanout</span><span className="mon-stat-value">{subsz.max_fanout || 0}</span></div>
            <div className="mon-stat"><span className="mon-stat-label">Avg Fanout</span><span className="mon-stat-value">{(subsz.avg_fanout || 0).toFixed(1)}</span></div>
          </div>
        </div>
      )}

      {/* Active Connections Table */}
      {connz && connz.connections && connz.connections.length > 0 && (
        <div className="mon-card">
          <div className="mon-card-header">Active Connections ({connz.num_connections})</div>
          <div className="mon-table-wrap">
            <table className="mon-table">
              <thead>
                <tr>
                  <th>CID</th>
                  <th>Name</th>
                  <th>IP</th>
                  <th>Subs</th>
                  <th>Msgs In</th>
                  <th>Msgs Out</th>
                  <th>Data In</th>
                  <th>Data Out</th>
                  <th>RTT</th>
                  <th>Uptime</th>
                  <th>Lang</th>
                </tr>
              </thead>
              <tbody>
                {connz.connections.map((c: any) => (
                  <tr key={c.cid}>
                    <td>{c.cid}</td>
                    <td className="mon-td-name">{c.name || '-'}</td>
                    <td className="mon-td-mono">{c.ip}:{c.port}</td>
                    <td>{c.subscriptions}</td>
                    <td>{formatNumber(c.in_msgs)}</td>
                    <td>{formatNumber(c.out_msgs)}</td>
                    <td>{formatBytes(c.in_bytes)}</td>
                    <td>{formatBytes(c.out_bytes)}</td>
                    <td>{c.rtt || '-'}</td>
                    <td>{c.uptime}</td>
                    <td>{c.lang} {c.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
