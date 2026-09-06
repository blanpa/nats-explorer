import { useStore } from '../../store';
import SubjectTree from '../subjects/SubjectTree';
import StreamList from '../jetstream/StreamList';
import KvBucketList from '../kv/KvBucketList';
import ObjStoreList from '../objectstore/ObjStoreList';
import ServiceList from '../services/ServiceList';
import TemplateList from '../requests/TemplateList';

export default function Explorer() {
  const module = useStore(s => s.module);
  const width = useStore(s => s.explorerWidth);

  return (
    <aside className="shrink-0 flex flex-col min-h-0 bg-panel border-r border-line" style={{ width }} aria-label="Explorer">
      {module === 'subjects' && <SubjectTree />}
      {module === 'jetstream' && <StreamList />}
      {module === 'kv' && <KvBucketList />}
      {module === 'objects' && <ObjStoreList />}
      {module === 'services' && <ServiceList />}
      {module === 'requests' && <TemplateList />}
    </aside>
  );
}
