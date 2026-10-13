import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Copy, Download, Eraser, Layers, Lock, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { StreamInfo } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { duplicateOf } from '../../lib/streamForm';
import { formatBytes, formatDateTime, formatDurationNs, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import {
  Badge,
  EmptyState,
  ErrorState,
  KeyValueGrid,
  LoadingState,
  menuClass,
  menuItemClass,
  PaneHeader,
  SectionTitle,
  StatStrip,
  StatTile,
  Tabs,
} from '../ui/misc';
import { toast } from '../ui/Toast';
import StreamDialog from './StreamDialog';
import StreamMessages from './StreamMessages';
import ConsumerList from './ConsumerList';
import StreamGaps from './StreamGaps';
import Replication from './Replication';
import { useCanWrite } from '../../lib/auth';

type Tab = 'overview' | 'messages' | 'consumers';

export default function StreamDetail() {
  const canWrite = useCanWrite();
  const connId = useStore(s => s.activeConnId);
  const name = useStore(s => s.selectedStream);
  const setSelected = useStore(s => s.setSelectedStream);
  const bump = useStore(s => s.bumpRefresh);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [copied, setCopied] = useState(false);

  const {
    data: stream,
    error,
    loading,
    initial,
    reload,
    setData,
  } = useAsync<StreamInfo>(() => (connId && name ? api.getStream(connId, name) : null), [connId, name], { key: `stream:${connId}:${name}`, interval: 5000 });

  if (!name) return <EmptyState icon={Layers} title="Select a stream" description="State, messages and consumers of a stream." />;
  if (initial && loading) return <LoadingState />;
  if (error && !stream) return <ErrorState title={`Cannot load stream ${name}`} message={error} action={<Button onClick={reload}>Retry</Button>} />;
  if (!stream || !connId) return null;

  const purge = async () => {
    if (
      !(await confirm({
        title: `Purge ${stream.name}?`,
        message: 'All messages in this stream are deleted. Consumers keep their configuration.',
        confirmLabel: 'Purge',
        danger: true,
      }))
    )
      return;
    try {
      await api.purgeStream(connId, stream.name);
      reload();
    } catch (err) {
      toast.error('Purge failed', errorMessage(err));
    }
  };

  const del = async () => {
    if (
      !(await confirm({
        title: `Delete stream ${stream.name}?`,
        message: 'The stream, its messages and all consumers are removed permanently.',
        confirmLabel: 'Delete stream',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteStream(connId, stream.name);
      setSelected(null);
      bump();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  // The configuration in the server's own JSON, the one `nats stream add
  // --config` reads, so a stream can be carried to another cluster.
  const copyConfig = async () => {
    try {
      const cfg = await api.getStreamConfig(connId, stream.name);
      await navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error('Could not copy the configuration', errorMessage(err));
    }
  };

  const seal = async () => {
    if (
      !(await confirm({
        title: `Seal ${stream.name}?`,
        message: 'A sealed stream takes no more messages and loses none: no publish, no delete, no purge. There is no way back.',
        confirmLabel: 'Seal',
        danger: true,
      }))
    )
      return;
    try {
      setData(await api.sealStream(connId, stream.name));
      bump();
    } catch (err) {
      toast.error('Seal failed', errorMessage(err));
    }
  };

  // A backup is a zip laid out the way the nats CLI lays one out, so either
  // tool restores it. The link carries the session cookie like any download.
  const backup = (consumers: boolean) => {
    const a = document.createElement('a');
    a.href = api.getStreamBackupUrl(connId, stream.name, consumers);
    a.download = `${stream.name}-backup.zip`;
    a.click();
  };

  // A replica group that is stuck behind its leader, or a peer that is
  // gone for good: what `nats stream cluster step-down` and `peer-remove` do.
  const stepDown = async () => {
    try {
      await api.stepDownStream(connId, stream.name);
      toast.info('Leader stepped down', 'The new leader shows with the next refresh.');
      setTimeout(reload, 1500);
    } catch (err) {
      toast.error('Step-down failed', errorMessage(err));
    }
  };
  const removePeer = async (peer: string) => {
    if (
      !(await confirm({
        title: `Remove ${peer} from ${stream.name}?`,
        message: "The server leaves the stream's group and its copy is dropped; the meta leader places a new replica on another server, which then catches up.",
        confirmLabel: 'Remove peer',
        danger: true,
      }))
    )
      return;
    try {
      await api.removeStreamPeer(connId, stream.name, peer);
      setTimeout(reload, 1500);
    } catch (err) {
      toast.error('Peer not removed', errorMessage(err));
    }
  };

  const st = stream.state;
  // The server keeps entries of its own under _nats.*; they are its bookkeeping, not the reader's metadata.
  const userMetadata = Object.entries(stream.metadata ?? {}).filter(([k]) => !k.startsWith('_nats.'));

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        className="h-12"
        actions={
          <>
            <IconButton label="Refresh" loading={loading} onClick={reload}>
              <RefreshCw size={14} />
            </IconButton>
            {canWrite && (
              <>
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
            )}
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <IconButton label="More" size="sm">
                  <MoreHorizontal size={14} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className={menuClass} align="end" sideOffset={4}>
                  <DropdownMenu.Item className={menuItemClass} onSelect={copyConfig}>
                    {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />} Copy configuration as JSON
                  </DropdownMenu.Item>
                  {canWrite && (
                    <DropdownMenu.Item className={menuItemClass} onSelect={() => setDuplicating(true)}>
                      <Layers size={13} /> New stream like this one
                    </DropdownMenu.Item>
                  )}
                  {stream.storage !== 'Memory' && (
                    <>
                      <DropdownMenu.Item className={menuItemClass} onSelect={() => backup(false)}>
                        <Download size={13} /> Backup
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className={menuItemClass} onSelect={() => backup(true)}>
                        <Download size={13} /> Backup with consumers
                      </DropdownMenu.Item>
                    </>
                  )}
                  {canWrite && !stream.sealed && (
                    <DropdownMenu.Item className={menuItemClass} onSelect={seal}>
                      <Lock size={13} className="text-danger" /> Seal
                    </DropdownMenu.Item>
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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
              <StatTile
                label="Sequence"
                value={`${formatNumber(st.firstSeq)} – ${formatNumber(st.lastSeq)}`}
                sub={st.numDeleted ? `${formatNumber(st.numDeleted)} deleted` : undefined}
              />
              <StatTile
                label="Last message"
                value={st.messages ? formatDateTime(st.lastTs) : '–'}
                sub={st.messages ? `first ${formatDateTime(st.firstTs)}` : undefined}
                className="[&>div:nth-child(2)]:text-sm"
              />
            </StatStrip>

            <StreamGaps connId={connId} stream={stream.name} numDeleted={st.numDeleted ?? 0} />

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
                    { label: 'Compression', value: stream.compression === 's2' ? 'S2' : 'none' },
                    ...(stream.persistMode === 'async' ? [{ label: 'Persist mode', value: 'async' }] : []),
                    ...(stream.placement
                      ? [{ label: 'Placement', value: [stream.placement.cluster, ...(stream.placement.tags ?? [])].filter(Boolean).join(' · '), mono: true }]
                      : []),
                    { label: 'Allow direct', value: stream.allowDirect ? 'yes' : 'no' },
                    { label: 'Allow roll-up', value: stream.allowRollup ? 'yes' : 'no' },
                    { label: 'Deny delete / purge', value: `${stream.denyDelete ? 'yes' : 'no'} / ${stream.denyPurge ? 'yes' : 'no'}` },
                    { label: 'No ack', value: stream.noAck ? 'yes' : 'no' },
                    ...(stream.allowMsgCounter || stream.allowAtomicPublish || stream.allowMsgSchedules
                      ? [
                          {
                            label: 'NATS 2.12',
                            value: [
                              stream.allowMsgCounter && 'counters',
                              stream.allowAtomicPublish && 'atomic batches',
                              stream.allowMsgSchedules && 'schedules',
                            ]
                              .filter(Boolean)
                              .join(', '),
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            </div>

            {(stream.republish || stream.subjectTransform || userMetadata.length > 0) && (
              <div>
                <SectionTitle>Routing and metadata</SectionTitle>
                <KeyValueGrid
                  columns={1}
                  items={[
                    ...(stream.republish
                      ? [
                          {
                            label: 'Republish',
                            value: `${stream.republish.src || '>'} → ${stream.republish.dest}${stream.republish.headersOnly ? ' (headers only)' : ''}`,
                            mono: true,
                          },
                        ]
                      : []),
                    ...(stream.subjectTransform
                      ? [{ label: 'Subject transform', value: `${stream.subjectTransform.src || '>'} → ${stream.subjectTransform.dest}`, mono: true }]
                      : []),
                    ...userMetadata.map(([k, v]) => ({ label: k, value: v, mono: true })),
                  ]}
                />
              </div>
            )}

            <Replication stream={stream} />

            {stream.cluster && (
              <div>
                <SectionTitle
                  actions={
                    canWrite && stream.replicas > 1 ? (
                      <Button size="xs" variant="outline" onClick={stepDown}>
                        Step down
                      </Button>
                    ) : undefined
                  }
                >
                  Cluster{stream.cluster.name ? ` · ${stream.cluster.name}` : ''}
                </SectionTitle>
                <div className="card overflow-hidden">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Peer</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th className="num">Lag</th>
                        {canWrite && <th />}
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
                        {canWrite && <td />}
                      </tr>
                      {stream.cluster.replicas.map(r => (
                        <tr key={r.name}>
                          <td className="font-mono">{r.name}</td>
                          <td>replica</td>
                          <td>
                            {r.offline ? (
                              <Badge tone="danger">offline</Badge>
                            ) : r.current ? (
                              <Badge tone="ok">current</Badge>
                            ) : (
                              <Badge tone="warn">catching up</Badge>
                            )}
                          </td>
                          <td className="num">{formatNumber(r.lag)}</td>
                          {canWrite && (
                            <td className="text-right">
                              <Button size="xs" variant="ghost" className="text-danger" onClick={() => removePeer(r.name)}>
                                Remove
                              </Button>
                            </td>
                          )}
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
        {tab === 'consumers' && <ConsumerList connId={connId} stream={stream.name} streamLastSeq={stream.state.lastSeq} onChanged={reload} />}
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
      {duplicating && (
        <StreamDialog
          connId={connId}
          existing={duplicateOf(stream)}
          duplicate
          onClose={() => setDuplicating(false)}
          onSaved={info => {
            setDuplicating(false);
            bump();
            setSelected(info.name);
          }}
        />
      )}
    </div>
  );
}
