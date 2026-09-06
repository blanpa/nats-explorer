import { useState } from 'react';
import { Eraser, Layers, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { StreamInfo } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { formatBytes, formatDateTime, formatDurationNs, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { Badge, EmptyState, ErrorState, KeyValueGrid, LoadingState, PaneHeader, SectionTitle, StatStrip, StatTile, Tabs } from '../ui/misc';
import { toast } from '../ui/Toast';
import StreamDialog from './StreamDialog';
import StreamMessages from './StreamMessages';
import ConsumerList from './ConsumerList';

type Tab = 'overview' | 'messages' | 'consumers';

export default function StreamDetail() {
  const connId = useStore(s => s.activeConnId);
  const name = useStore(s => s.selectedStream);
  const setSelected = useStore(s => s.setSelectedStream);
  const bump = useStore(s => s.bumpRefresh);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);

  const { data: stream, error, loading, initial, reload, setData } = useAsync<StreamInfo>(
    () => (connId && name ? api.getStream(connId, name) : null),
    [connId, name],
    { key: `stream:${connId}:${name}`, interval: 5000 },
  );

  if (!name) return <EmptyState icon={Layers} title="Select a stream" description="Streams persist messages for the subjects they capture. Pick one to inspect its state, messages and consumers." />;
  if (initial && loading) return <LoadingState />;
  if (error && !stream) return <ErrorState title={`Cannot load stream ${name}`} message={error} action={<Button onClick={reload}>Retry</Button>} />;
  if (!stream || !connId) return null;

  const purge = async () => {
    if (!(await confirm({ title: `Purge ${stream.name}?`, message: 'All messages in this stream are deleted. Consumers keep their configuration.', confirmLabel: 'Purge', danger: true }))) return;
    try {
      await api.purgeStream(connId, stream.name);
      reload();
    } catch (err) {
      toast.error('Purge failed', errorMessage(err));
    }
  };

  const del = async () => {
    if (!(await confirm({ title: `Delete stream ${stream.name}?`, message: 'The stream, its messages and all consumers are removed permanently.', confirmLabel: 'Delete stream', danger: true }))) return;
    try {
      await api.deleteStream(connId, stream.name);
      setSelected(null);
      bump();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const st = stream.state;

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        className="h-12"
        actions={
          <>
            <IconButton label="Refresh" loading={loading} onClick={reload}>
              <RefreshCw size={14} />
            </IconButton>
            <Button variant="outline" icon={<Pencil size={13} />} onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="outline" icon={<Eraser size={13} />} onClick={purge} disabled={stream.denyPurge}>
              Purge
            </Button>
            <Button variant="danger" icon={<Trash2 size={13} />} onClick={del}>
              Delete
            </Button>
          </>
        }
      >
        <Layers size={16} className="text-accent shrink-0" />
        <div className="min-w-0">
          <div className="text-md font-semibold truncate">{stream.name}</div>
          {stream.description && <div className="text-xs text-muted truncate">{stream.description}</div>}
        </div>
        <div className="flex items-center gap-1 ml-2">
          <Badge tone="neutral">{stream.retention}</Badge>
          <Badge tone={stream.storage === 'Memory' ? 'info' : 'neutral'}>{stream.storage}</Badge>
          <Badge tone="neutral">R{stream.replicas}</Badge>
          {stream.sealed && <Badge tone="warn">sealed</Badge>}
        </div>
      </PaneHeader>

      <Tabs
        className="px-3"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'messages', label: 'Messages', count: st.messages },
          { id: 'consumers', label: 'Consumers', count: st.consumerCount },
        ]}
      />

      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'overview' && (
          <div className="p-4 flex flex-col gap-5">
            <StatStrip>
              <StatTile label="Messages" value={formatNumber(st.messages)} />
              <StatTile label="Size" value={formatBytes(st.bytes)} />
              <StatTile label="Subjects" value={formatNumber(st.numSubjects)} />
              <StatTile label="Consumers" value={st.consumerCount} />
              <StatTile label="Sequence" value={`${formatNumber(st.firstSeq)} – ${formatNumber(st.lastSeq)}`} sub={st.numDeleted ? `${formatNumber(st.numDeleted)} deleted` : undefined} />
              <StatTile label="Last message" value={st.messages ? formatDateTime(st.lastTs) : '–'} sub={st.messages ? `first ${formatDateTime(st.firstTs)}` : undefined} className="[&>div:nth-child(2)]:text-sm" />
            </StatStrip>

            <div>
              <SectionTitle>Subjects</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {stream.subjects.length === 0 && <span className="text-sm text-muted">No subjects (sourced or mirrored)</span>}
                {stream.subjects.map(s => (
                  <Badge key={s} tone="accent" mono>
                    {s}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div>
                <SectionTitle>Limits</SectionTitle>
                <KeyValueGrid
                  columns={1}
                  items={[
                    { label: 'Max messages', value: formatNumber(stream.maxMsgs) },
                    { label: 'Max messages per subject', value: formatNumber(stream.maxMsgsPerSubject) },
                    { label: 'Max bytes', value: formatBytes(stream.maxBytes) },
                    { label: 'Max age', value: formatDurationNs(stream.maxAge) },
                    { label: 'Max message size', value: formatBytes(stream.maxMsgSize) },
                    { label: 'Max consumers', value: formatNumber(stream.maxConsumers) },
                    { label: 'Discard policy', value: stream.discard },
                    { label: 'Duplicate window', value: formatDurationNs(stream.duplicateWindow) },
                  ]}
                />
              </div>
              <div>
                <SectionTitle>Configuration</SectionTitle>
                <KeyValueGrid
                  columns={1}
                  items={[
                    { label: 'Created', value: formatDateTime(stream.created) },
                    { label: 'Retention', value: stream.retention },
                    { label: 'Storage', value: stream.storage },
                    { label: 'Replicas', value: stream.replicas },
                    { label: 'Allow direct', value: stream.allowDirect ? 'yes' : 'no' },
                    { label: 'Allow roll-up', value: stream.allowRollup ? 'yes' : 'no' },
                    { label: 'Deny delete / purge', value: `${stream.denyDelete ? 'yes' : 'no'} / ${stream.denyPurge ? 'yes' : 'no'}` },
                    { label: 'No ack', value: stream.noAck ? 'yes' : 'no' },
                    ...(stream.mirror ? [{ label: 'Mirror of', value: stream.mirror, mono: true }] : []),
                    ...(stream.sources?.length ? [{ label: 'Sources', value: stream.sources.join(', '), mono: true }] : []),
                  ]}
                />
              </div>
            </div>

            {stream.cluster && (
              <div>
                <SectionTitle>Cluster{stream.cluster.name ? ` · ${stream.cluster.name}` : ''}</SectionTitle>
                <div className="card overflow-hidden">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Peer</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th className="num">Lag</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="font-mono">{stream.cluster.leader || '–'}</td>
                        <td>
                          <Badge tone="accent">leader</Badge>
                        </td>
                        <td>
                          <Badge tone="ok">current</Badge>
                        </td>
                        <td className="num">0</td>
                      </tr>
                      {stream.cluster.replicas.map(r => (
                        <tr key={r.name}>
                          <td className="font-mono">{r.name}</td>
                          <td>replica</td>
                          <td>{r.offline ? <Badge tone="danger">offline</Badge> : r.current ? <Badge tone="ok">current</Badge> : <Badge tone="warn">catching up</Badge>}</td>
                          <td className="num">{formatNumber(r.lag)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
        {tab === 'messages' && <StreamMessages connId={connId} stream={stream} onChanged={reload} />}
        {tab === 'consumers' && <ConsumerList connId={connId} stream={stream.name} onChanged={reload} />}
      </div>

      {editing && (
        <StreamDialog
          connId={connId}
          existing={stream}
          onClose={() => setEditing(false)}
          onSaved={info => {
            setEditing(false);
            setData(info);
            bump();
          }}
        />
      )}
    </div>
  );
}
