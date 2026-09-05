import { Cable, Plug } from 'lucide-react';
import { useStore } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/misc';
import SubjectDetail from '../subjects/SubjectDetail';
import StreamDetail from '../jetstream/StreamDetail';
import KvBucketView from '../kv/KvBucketView';
import ObjStoreView from '../objectstore/ObjStoreView';
import ServiceDetail from '../services/ServiceDetail';
import MonitoringDashboard from '../monitoring/MonitoringDashboard';
import ClusterView from '../cluster/ClusterView';

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
      description="Connect to a NATS server to browse subjects, JetStream, Key-Value and Object stores."
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

export default function Detail() {
  const module = useStore(s => s.module);
  const hasConnection = useStore(s => s.connections.some(c => c.connected));

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-canvas">
      {!hasConnection ? (
        <NoConnection />
      ) : (
        <>
          {module === 'subjects' && <SubjectDetail />}
          {module === 'jetstream' && <StreamDetail />}
          {module === 'kv' && <KvBucketView />}
          {module === 'objects' && <ObjStoreView />}
          {module === 'services' && <ServiceDetail />}
          {module === 'monitor' && <MonitoringDashboard />}
          {module === 'cluster' && <ClusterView />}
        </>
      )}
    </main>
  );
}
