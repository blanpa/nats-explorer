import { useStore } from '../../store';
import MessageView from '../messages/MessageView';
import StreamDetail from '../jetstream/StreamDetail';
import KvBucketView from '../kv/KvBucketView';
import ObjStoreView from '../objectstore/ObjStoreView';
import PublishPanel from '../publish/PublishPanel';
import MonitoringDashboard from '../monitoring/MonitoringDashboard';
import ServiceList from '../services/ServiceList';

export default function MainContent() {
  const { activeTab, connections } = useStore();
  const hasConnections = connections.some(c => c.connected);

  if (!hasConnections) {
    return (
      <div className="main-empty">
        <div className="main-empty-logo">NATS</div>
        <p className="main-empty-text">Connect to a NATS server to get started</p>
      </div>
    );
  }

  return (
    <div className="main-split">
      <div className="main-detail-area">
        {activeTab === 'subjects' && <MessageView />}
        {activeTab === 'jetstream' && <StreamDetail />}
        {activeTab === 'kv' && <KvBucketView />}
        {activeTab === 'objectstore' && <ObjStoreView />}
        {activeTab === 'cluster' && (
          <div className="detail-empty">
            <p>Select a server from the cluster tab to view details</p>
          </div>
        )}
        {activeTab === 'monitor' && <MonitoringDashboard />}
        {activeTab === 'services' && <ServiceList />}
      </div>
      {activeTab === 'subjects' && (
        <div className="main-publish-area">
          <PublishPanel />
        </div>
      )}
    </div>
  );
}
