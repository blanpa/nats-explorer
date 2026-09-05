import { Radio, RefreshCw, Send } from 'lucide-react';
import { useStore } from '../../store';
import { useServices } from '../../store/services';
import { formatDateTime, formatDurationMs, formatNumber, formatRelative } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Badge, EmptyState, KeyValueGrid, PaneHeader, SectionTitle, StatTile } from '../ui/misc';

export default function ServiceDetail() {
  const connId = useStore(s => s.activeConnId);
  const selectedId = useStore(s => s.selectedService);
  const setModule = useStore(s => s.setModule);
  const prefillPublish = useStore(s => s.prefillPublish);
  const { services, stats, loading, refresh } = useServices();

  const svc = services.find(s => s.id === selectedId);
  if (!svc) return <EmptyState icon={Radio} title="Select a service" description="Services built with the NATS micro framework expose info, statistics and endpoints for discovery." />;

  const st = stats.find(s => s.id === svc.id);
  const totalReq = st?.endpoints?.reduce((n, e) => n + (e.num_requests || 0), 0) ?? 0;
  const totalErr = st?.endpoints?.reduce((n, e) => n + (e.num_errors || 0), 0) ?? 0;
  const avgNs = st?.endpoints?.length ? st.endpoints.reduce((n, e) => n + (e.average_processing_time || 0), 0) / st.endpoints.length : 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        className="h-12"
        actions={
          <IconButton label="Refresh" loading={loading} onClick={() => connId && refresh(connId)}>
            <RefreshCw size={14} />
          </IconButton>
        }
      >
        <Radio size={16} className="text-accent shrink-0" />
        <div className="min-w-0">
          <div className="text-md font-semibold truncate">
            {svc.name} <span className="text-muted font-normal">v{svc.version}</span>
          </div>
          <div className="text-xs text-muted font-mono truncate">{svc.id}</div>
        </div>
        {svc.description && <span className="text-sm text-muted truncate ml-2">{svc.description}</span>}
      </PaneHeader>

      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile label="Requests" value={formatNumber(totalReq)} />
          <StatTile label="Errors" value={formatNumber(totalErr)} tone={totalErr > 0 ? 'danger' : undefined} />
          <StatTile label="Avg processing" value={avgNs ? formatDurationMs(avgNs / 1e6) : '–'} />
          <StatTile label="Started" value={st ? formatRelative(st.started) : '–'} sub={st ? formatDateTime(st.started) : undefined} className="[&>div:nth-child(2)]:text-sm" />
        </div>

        <div>
          <SectionTitle>Endpoints · {svc.endpoints?.length ?? 0}</SectionTitle>
          <div className="card overflow-hidden">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Subject</th>
                  <th>Queue group</th>
                  <th className="num">Requests</th>
                  <th className="num">Errors</th>
                  <th className="num">Avg time</th>
                  <th>Last error</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {(svc.endpoints ?? []).map(ep => {
                  const es = st?.endpoints?.find(e => e.name === ep.name);
                  return (
                    <tr key={ep.name}>
                      <td className="font-medium">{ep.name}</td>
                      <td className="font-mono">{ep.subject}</td>
                      <td className="text-muted">{ep.queue_group || '–'}</td>
                      <td className="num">{formatNumber(es?.num_requests ?? 0)}</td>
                      <td className={`num ${es?.num_errors ? 'text-danger' : ''}`}>{formatNumber(es?.num_errors ?? 0)}</td>
                      <td className="num text-muted">{es?.average_processing_time ? formatDurationMs(es.average_processing_time / 1e6) : '–'}</td>
                      <td className="text-danger font-mono text-xs max-w-[240px] truncate" title={es?.last_error}>
                        {es?.last_error || '–'}
                      </td>
                      <td>
                        <IconButton
                          label="Send a request to this endpoint"
                          size="xs"
                          onClick={() => {
                            prefillPublish({ subject: ep.subject });
                            setModule('subjects');
                          }}
                        >
                          <Send size={12} />
                        </IconButton>
                      </td>
                    </tr>
                  );
                })}
                {(svc.endpoints ?? []).length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-muted text-center py-4">
                      No endpoints reported
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {svc.metadata && Object.keys(svc.metadata).length > 0 && (
          <div>
            <SectionTitle>Metadata</SectionTitle>
            <KeyValueGrid columns={2} items={Object.entries(svc.metadata).map(([k, v]) => ({ label: k, value: String(v), mono: true }))} />
          </div>
        )}

        <div className="text-xs text-faint flex items-center gap-2">
          <Badge tone="neutral">{svc.type}</Badge>
          <Button size="xs" variant="ghost" onClick={() => { prefillPublish({ subject: `$SRV.PING.${svc.name}` }); setModule('subjects'); }}>
            Ping via request
          </Button>
        </div>
      </div>
    </div>
  );
}
