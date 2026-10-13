import { useStore } from '../../store';
import SubjectTree from '../subjects/SubjectTree';
import StreamList from '../jetstream/StreamList';
import KvBucketList from '../kv/KvBucketList';
import ObjStoreList from '../objectstore/ObjStoreList';
import ServiceList from '../services/ServiceList';
import TemplateList from '../requests/TemplateList';

/** The list pane of the module; `fill` takes the whole width, on a narrow window. */
export default function Explorer({ fill }: { fill?: boolean }) {
  const module = useStore(s => s.module);
  const width = useStore(s => s.explorerWidth);

  return (
    <aside
      className={fill ? 'flex-1 min-w-0 flex flex-col min-h-0 bg-panel' : 'shrink-0 flex flex-col min-h-0 bg-panel border-r border-line'}
      style={fill ? undefined : { width }}
      aria-label="Explorer"
    >
      {module === 'subjects' && <SubjectTree />}
      {module === 'jetstream' && <StreamList />}
      {module === 'kv' && <KvBucketList />}
      {module === 'objects' && <ObjStoreList />}
      {module === 'services' && <ServiceList />}
      {module === 'requests' && <TemplateList />}
    </aside>
  );
}
