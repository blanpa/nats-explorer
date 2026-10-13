import { useRef, useState } from 'react';
import { Archive, Download, FileIcon, Lock, RefreshCw, Trash2, Upload } from 'lucide-react';
import type { ObjInfo } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { cn, formatBytes, formatCount, formatDateTime, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import { toast } from '../ui/Toast';
import { useCanWrite } from '../../lib/auth';

export default function ObjStoreView() {
  const canWrite = useCanWrite();
  const connId = useStore(s => s.activeConnId);
  const store = useStore(s => s.selectedObjStore);
  const setStore = useStore(s => s.setSelectedObjStore);
  const bump = useStore(s => s.bumpRefresh);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const stores = useAsync(() => (connId ? api.listObjectStores(connId) : null), [connId, store], { key: `objstores:${connId}` });
  const sealed = !!stores.data?.find(s => s.bucket === store)?.sealed;

  const { data, error, loading, initial, reload } = useAsync<ObjInfo[]>(() => (connId && store ? api.listObjects(connId, store) : null), [connId, store], {
    key: `objects:${connId}:${store}`,
  });

  if (!store) return <EmptyState icon={Archive} title="Select an object store" description="Upload, download and delete objects of a store." />;
  if (!connId) return null;

  const upload = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        await api.putObject(connId, store, file);
      } catch (err) {
        toast.error(`Upload of ${file.name} failed`, errorMessage(err));
      }
    }
    setUploading(null);
    reload();
    bump();
  };

  // Streamed by the browser straight from the backend; nothing is buffered in memory.
  const download = (name: string) => {
    const a = document.createElement('a');
    a.href = api.getObjectUrl(connId, store, name);
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const del = async (name: string) => {
    if (!(await confirm({ title: `Delete ${name}?`, message: 'The object is removed from the store.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deleteObject(connId, store, name);
      reload();
      bump();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const deleteChecked = async () => {
    const names = [...checked];
    if (
      !(await confirm({
        title: `Delete ${formatCount(names.length)} objects?`,
        message: 'They are removed from the store.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      const res = await api.deleteObjects(connId, store, names);
      const failed = Object.entries(res.failed);
      if (failed.length) toast.warning(`${failed.length} of ${names.length} objects not deleted`, failed.map(([n, e]) => `${n}: ${e}`).join('\n'));
      setChecked(new Set());
      reload();
      bump();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const seal = async () => {
    if (
      !(await confirm({
        title: `Seal ${store}?`,
        message: 'A sealed store takes no more uploads and loses no objects. There is no way back.',
        confirmLabel: 'Seal',
        danger: true,
      }))
    )
      return;
    try {
      await api.sealObjectStore(connId, store);
      stores.reload();
      bump();
    } catch (err) {
      toast.error('Seal failed', errorMessage(err));
    }
  };

  const deleteStore = async () => {
    if (
      !(await confirm({
        title: `Delete object store ${store}?`,
        message: 'All objects in this store are removed permanently.',
        confirmLabel: 'Delete store',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteObjectStore(connId, store);
      setStore(null);
      bump();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const objects = data ?? [];
  const totalSize = objects.reduce((s, o) => s + o.size, 0);

  return (
    <div
      className="flex flex-col h-full min-h-0 relative"
      onDragOver={e => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
      }}
    >
      <PaneHeader
        className="h-12"
        actions={
          <>
            <IconButton label="Refresh" loading={loading && !initial} onClick={reload}>
              <RefreshCw size={14} />
            </IconButton>
            <input ref={fileInput} type="file" multiple hidden onChange={e => e.target.files && upload(e.target.files)} />
            {canWrite && (
              <>
                {checked.size > 0 && !sealed && (
                  <Button variant="danger" icon={<Trash2 size={13} />} onClick={deleteChecked}>
                    Delete {formatCount(checked.size)}
                  </Button>
                )}
                {!sealed && (
                  <IconButton label="Seal the store" onClick={seal}>
                    <Lock size={14} />
                  </IconButton>
                )}
                <Button variant="primary" icon={<Upload size={13} />} loading={!!uploading} disabled={sealed} onClick={() => fileInput.current?.click()}>
                  {uploading ? `Uploading ${uploading}` : 'Upload'}
                </Button>
                <Button variant="danger" icon={<Trash2 size={13} />} onClick={deleteStore}>
                  Delete store
                </Button>
              </>
            )}
          </>
        }
      >
        <Archive size={16} className="text-accent shrink-0" />
        <div className="min-w-0">
          <div className="text-md font-semibold truncate flex items-center gap-1.5">
            {store}
            {sealed && <Badge tone="warn">sealed</Badge>}
          </div>
          <div className="text-xs text-muted">
            {formatCount(objects.length)} objects · {formatBytes(totalSize)}
          </div>
        </div>
      </PaneHeader>

      <div className="flex-1 min-h-0 overflow-auto">
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot list objects" message={error} />
        ) : objects.length === 0 ? (
          <EmptyState icon={FileIcon} title="No objects" description="Drop files here or use Upload." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                {canWrite && !sealed && (
                  <th className="w-8">
                    <input
                      type="checkbox"
                      className="checkbox"
                      aria-label="Tick every object"
                      checked={objects.length > 0 && objects.every(o => checked.has(o.name))}
                      onChange={e => setChecked(e.target.checked ? new Set(objects.map(o => o.name)) : new Set())}
                    />
                  </th>
                )}
                <th>Name</th>
                <th>Description</th>
                <th className="num">Size</th>
                <th className="num">Chunks</th>
                <th>Modified</th>
                <th>Digest</th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {objects.map(o => (
                <tr key={o.name}>
                  {canWrite && !sealed && (
                    <td>
                      <input
                        type="checkbox"
                        className="checkbox"
                        aria-label={`Tick ${o.name}`}
                        checked={checked.has(o.name)}
                        onChange={e =>
                          setChecked(prev => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(o.name);
                            else next.delete(o.name);
                            return next;
                          })
                        }
                      />
                    </td>
                  )}
                  <td className="font-mono">
                    <span className="inline-flex items-center gap-2">
                      <FileIcon size={13} className="text-muted" /> {o.name}
                    </span>
                  </td>
                  <td className="text-muted max-w-[260px] truncate">{o.description || '–'}</td>
                  <td className="num">{formatBytes(o.size)}</td>
                  <td className="num text-muted">{formatNumber(o.chunks)}</td>
                  <td className="font-mono text-muted">{o.mtime ? formatDateTime(o.mtime) : '–'}</td>
                  <td className="font-mono text-faint text-xs max-w-[160px] truncate" title={o.digest}>
                    {o.digest?.replace(/^SHA-256=/, '') || '–'}
                  </td>
                  <td>
                    <div className="flex items-center justify-end gap-0.5">
                      <IconButton label="Download" size="xs" onClick={() => download(o.name)}>
                        <Download size={13} />
                      </IconButton>
                      {canWrite && (
                        <IconButton label="Delete" size="xs" onClick={() => del(o.name)}>
                          <Trash2 size={13} className="text-danger" />
                        </IconButton>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div
        className={cn(
          'absolute inset-2 rounded-lg border-2 border-dashed border-accent bg-accent/10 flex items-center justify-center text-md font-medium text-accent pointer-events-none transition-opacity',
          dragging ? 'opacity-100' : 'opacity-0',
        )}
      >
        Drop files to upload to {store}
      </div>
    </div>
  );
}
