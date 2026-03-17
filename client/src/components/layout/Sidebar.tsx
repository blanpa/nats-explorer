import { useStore } from '../../store';
import SubjectTree from '../subjects/SubjectTree';
import StreamList from '../jetstream/StreamList';
import KvBucketList from '../kv/KvBucketList';
import ObjStoreList from '../objectstore/ObjStoreList';
import ClusterView from '../cluster/ClusterView';

export default function Sidebar() {
  const { activeTab, setActiveTab, subjectFilter, setSubjectFilter, connections } = useStore();
  const hasConnections = connections.some(c => c.connected);

  const tabs = [
    { id: 'subjects' as const, label: 'Subjects' },
    { id: 'jetstream' as const, label: 'JetStream' },
    { id: 'kv' as const, label: 'KV' },
    { id: 'objectstore' as const, label: 'Objects' },
    { id: 'cluster' as const, label: 'Cluster' },
    { id: 'monitor' as const, label: 'Monitor' },
    { id: 'services' as const, label: 'Services' },
  ];

  return (
    <div className="sidebar-inner">
      <div className="sidebar-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`sidebar-tab ${activeTab === tab.id ? 'sidebar-tab-active' : ''}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="sidebar-content">
        {!hasConnections ? (
          <div className="sidebar-empty">Connect to a NATS server to start exploring</div>
        ) : (
          <>
            {activeTab === 'subjects' && <SubjectTree />}
            {activeTab === 'jetstream' && <StreamList />}
            {activeTab === 'kv' && <KvBucketList />}
            {activeTab === 'objectstore' && <ObjStoreList />}
            {activeTab === 'cluster' && <ClusterView />}
          </>
        )}
      </div>

      {activeTab === 'subjects' && (
        <div className="sidebar-search">
          <input
            value={subjectFilter}
            onChange={e => setSubjectFilter(e.target.value)}
            placeholder="Search subjects..."
            className="sidebar-search-input"
          />
        </div>
      )}
    </div>
  );
}
