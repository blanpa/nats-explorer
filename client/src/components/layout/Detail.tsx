import { ArrowLeftRight, Cable, Plug, X } from 'lucide-react';
import { type SplitModule, useStore } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import { Button, IconButton } from '../ui/Button';
import { BesidePane } from '../../lib/pane';
import { useNarrow } from '../../lib/narrow';
import { EmptyState } from '../ui/misc';
import SubjectDetail from '../subjects/SubjectDetail';
import StreamDetail from '../jetstream/StreamDetail';
import KvBucketView from '../kv/KvBucketView';
import ObjStoreView from '../objectstore/ObjStoreView';
import ServiceDetail from '../services/ServiceDetail';
import MonitoringDashboard from '../monitoring/MonitoringDashboard';
import EventsView from '../events/EventsView';
import StateView from '../state/StateView';
import ClusterView from '../cluster/ClusterView';
import AlertsView from '../alerts/AlertsView';
import AuditView from '../audit/AuditView';
import TemplateEditor from '../requests/TemplateEditor';

function NoConnection() {
  const openDialog = useStore(s => s.openConnectionsDialog);
  const saved = useSavedConnections(s => s.items);
  const connect = useSavedConnections(s => s.connect);
  const connecting = useSavedConnections(s => s.connecting);
  const first = saved[0];

  return (
    <EmptyState
      icon={Cable}
      title="Not connected"
      description="Connect to a server to get started."
      action={
        <div className="flex items-center gap-2">
          {first && (
            <Button variant="primary" size="md" icon={<Plug size={13} />} loading={connecting.has(first.id)} onClick={() => connect(first.id)}>
              Connect to {first.name || first.servers[0]}
            </Button>
          )}
          <Button variant="outline" size="md" onClick={() => openDialog()}>
            Manage connections
          </Button>
        </div>
      }
    />
  );
}

const BESIDE_LABEL: Record<SplitModule, string> = { jetstream: 'stream', kv: 'bucket', objects: 'store' };

/**
 * A second stream, bucket or store next to the first: the main pane keeps
 * following the list, the one beside keeps what it was opened on.
 */
function Split({ module, main, other }: { module: SplitModule; main: React.ReactNode; other: React.ReactNode }) {
  const beside = useStore(s => s.beside);
  const close = useStore(s => s.closeBeside);
  const open = useStore(s => s.openBeside);
  const narrow = useNarrow();
  const current = useStore(s => (module === 'jetstream' ? s.selectedStream : module === 'kv' ? s.selectedKvBucket : s.selectedObjStore));
  const select = useStore(s => (module === 'jetstream' ? s.setSelectedStream : module === 'kv' ? s.setSelectedKvBucket : s.setSelectedObjStore));
  // On a narrow window there is no room for two; the second waits.
  if (!beside || beside.module !== module || narrow) return <>{main}</>;
  const swap = () => {
    if (!current) return;
    const other = beside.name;
    open(module, current);
    select(other);
  };
  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col">{main}</div>
      <div className="flex-1 min-w-0 flex flex-col border-l-2 border-line-strong">
        <div className="shrink-0 h-7 px-3 flex items-center gap-2 border-b border-line bg-panel text-xs text-muted">
          <span>
            Beside: {BESIDE_LABEL[module]} <span className="font-mono text-fg">{beside.name}</span>
          </span>
          <span className="ml-auto flex items-center gap-0.5">
            {current && (
              <IconButton label="Swap the two panes" size="xs" onClick={swap}>
                <ArrowLeftRight size={12} />
              </IconButton>
            )}
            <IconButton label="Close this pane" size="xs" onClick={close}>
              <X size={12} />
            </IconButton>
          </span>
        </div>
        <BesidePane key={`${module}:${beside.name}`} module={module} name={beside.name}>
          {other}
        </BesidePane>
      </div>
    </div>
  );
}

export default function Detail() {
  const module = useStore(s => s.module);
  const hasConnection = useStore(s => s.connections.some(c => c.connected));
  const loaded = useStore(s => s.connectionsLoaded);

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-canvas">
      {module === 'requests' ? (
        <TemplateEditor />
      ) : module === 'alerts' ? (
        <AlertsView />
      ) : module === 'audit' ? (
        <AuditView />
      ) : !loaded ? null : !hasConnection ? (
        <NoConnection />
      ) : (
        <>
          {module === 'subjects' && <SubjectDetail />}
          {module === 'state' && <StateView />}
          {module === 'jetstream' && <Split module="jetstream" main={<StreamDetail />} other={<StreamDetail />} />}
          {module === 'kv' && <Split module="kv" main={<KvBucketView />} other={<KvBucketView />} />}
          {module === 'objects' && <Split module="objects" main={<ObjStoreView />} other={<ObjStoreView />} />}
          {module === 'services' && <ServiceDetail />}
          {module === 'events' && <EventsView />}
          {module === 'monitor' && <MonitoringDashboard />}
          {module === 'cluster' && <ClusterView />}
        </>
      )}
    </main>
  );
}
