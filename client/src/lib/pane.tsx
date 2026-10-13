import { createContext, useContext, useState, type ReactNode } from 'react';
import { type SplitModule, useStore } from '../store';

/**
 * What a detail pane shows. The main pane follows the store, which the
 * address bar and the lists follow too; a pane opened beside it keeps its
 * own selection, so two streams, buckets or stores can be looked at side by
 * side. The views ask the hooks below and do not care which pane they are in.
 */
interface PaneSelection {
  stream: string | null;
  setStream: (name: string | null) => void;
  bucket: string | null;
  setBucket: (name: string | null) => void;
  kvKey: string | null;
  setKvKey: (key: string | null) => void;
  objStore: string | null;
  setObjStore: (name: string | null) => void;
}

const PaneContext = createContext<PaneSelection | null>(null);

/** True inside the pane opened beside the main one. */
export function useIsBesidePane(): boolean {
  return useContext(PaneContext) !== null;
}

export function useSelectedStream(): [string | null, (name: string | null) => void] {
  const pane = useContext(PaneContext);
  const value = useStore(s => s.selectedStream);
  const set = useStore(s => s.setSelectedStream);
  return pane ? [pane.stream, pane.setStream] : [value, set];
}

export function useSelectedKvBucket(): [string | null, (name: string | null) => void] {
  const pane = useContext(PaneContext);
  const value = useStore(s => s.selectedKvBucket);
  const set = useStore(s => s.setSelectedKvBucket);
  return pane ? [pane.bucket, pane.setBucket] : [value, set];
}

export function useSelectedKvKey(): [string | null, (key: string | null) => void] {
  const pane = useContext(PaneContext);
  const value = useStore(s => s.selectedKvKey);
  const set = useStore(s => s.setSelectedKvKey);
  return pane ? [pane.kvKey, pane.setKvKey] : [value, set];
}

export function useSelectedObjStore(): [string | null, (name: string | null) => void] {
  const pane = useContext(PaneContext);
  const value = useStore(s => s.selectedObjStore);
  const set = useStore(s => s.setSelectedObjStore);
  return pane ? [pane.objStore, pane.setObjStore] : [value, set];
}

/**
 * The pane beside the main one, holding the stream, bucket or store it was
 * opened on. Clearing that -- a delete, a close -- closes the pane.
 */
export function BesidePane({ module, name, children }: { module: SplitModule; name: string; children: ReactNode }) {
  const close = useStore(s => s.closeBeside);
  const [stream, setStreamState] = useState<string | null>(module === 'jetstream' ? name : null);
  const [bucket, setBucketState] = useState<string | null>(module === 'kv' ? name : null);
  const [kvKey, setKvKey] = useState<string | null>(null);
  const [objStore, setObjStoreState] = useState<string | null>(module === 'objects' ? name : null);
  const closing =
    <T,>(set: (v: T | null) => void) =>
    (v: T | null) => {
      if (v === null) close();
      else set(v);
    };
  const value: PaneSelection = {
    stream,
    setStream: closing(setStreamState),
    bucket,
    setBucket: closing((b: string | null) => {
      setBucketState(b);
      setKvKey(null);
    }),
    kvKey,
    setKvKey,
    objStore,
    setObjStore: closing(setObjStoreState),
  };
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}
