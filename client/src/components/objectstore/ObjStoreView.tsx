import { useState, useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { formatBytes } from '../../lib/utils';
import { Download, Trash2, RefreshCw, FileIcon, Upload } from 'lucide-react';

export default function ObjStoreView() {
  const activeConnId = useStore(s => s.activeConnId);
  const [storeName, setStoreName] = useState<string | null>(null);
  const [objects, setObjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !storeName || !activeConnId) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      try {
        await api.putObject(activeConnId, storeName, file.name, base64);
        loadObjects();
      } catch (err: any) {
        alert(`Upload failed: ${err.message}`);
      }
    };
    reader.readAsDataURL(file);
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  useEffect(() => {
    const unsub = useStore.subscribe((state: any) => {
      if (state._selectedObjStore !== storeName) {
        setStoreName(state._selectedObjStore || null);
      }
    });
    const initial = (useStore.getState() as any)._selectedObjStore;
    if (initial) setStoreName(initial);
    return unsub;
  }, []);

  useEffect(() => {
    if (storeName) loadObjects();
  }, [storeName, activeConnId]);

  const loadObjects = async () => {
    if (!storeName || !activeConnId) return;
    setLoading(true);
    try {
      const data = await api.listObjects(activeConnId, storeName);
      setObjects(data.filter((o: any) => !o.deleted));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = (name: string) => {
    if (!storeName || !activeConnId) return;
    window.open(api.getObjectUrl(activeConnId, storeName, name), '_blank');
  };

  const handleDelete = async (name: string) => {
    if (!storeName || !activeConnId || !confirm(`Delete object ${name}?`)) return;
    try {
      await api.deleteObject(activeConnId, storeName, name);
      loadObjects();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (!storeName) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Select an object store to browse objects
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-border bg-card/50 flex items-center justify-between">
        <h2 className="font-medium text-sm">Object Store: {storeName}</h2>
        <div className="flex items-center gap-1">
          <button onClick={() => fileInputRef.current?.click()} className="p-1 hover:bg-accent rounded" title="Upload object">
            <Upload size={14} />
          </button>
          <input ref={fileInputRef} type="file" onChange={handleUpload} style={{ display: 'none' }} />
          <button onClick={loadObjects} className="p-1 hover:bg-accent rounded">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {objects.length === 0 && !loading ? (
          <div className="p-4 text-center text-muted-foreground text-sm">No objects</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-right px-4 py-2 font-medium">Size</th>
                <th className="text-right px-4 py-2 font-medium">Chunks</th>
                <th className="text-right px-4 py-2 font-medium">Modified</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {objects.map(obj => (
                <tr key={obj.name} className="border-b border-border hover:bg-accent">
                  <td className="px-4 py-2 flex items-center gap-2">
                    <FileIcon size={12} className="text-primary" />
                    {obj.name}
                  </td>
                  <td className="text-right px-4 py-2">{formatBytes(obj.size)}</td>
                  <td className="text-right px-4 py-2">{obj.chunks}</td>
                  <td className="text-right px-4 py-2">{obj.mtime ? new Date(obj.mtime).toLocaleString() : '-'}</td>
                  <td className="text-right px-4 py-2">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => handleDownload(obj.name)} className="p-1 hover:bg-accent rounded"><Download size={12} /></button>
                      <button onClick={() => handleDelete(obj.name)} className="p-1 hover:bg-destructive/20 rounded text-destructive"><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
