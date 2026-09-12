import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** true only for the first load, so refreshes don't flash the UI */
  initial: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | null | ((prev: T | null) => T | null)) => void;
}

interface Options {
  /** poll every n ms while mounted */
  interval?: number;
  /** skip polling while the tab is hidden (default true) */
  pauseHidden?: boolean;
  /**
   * Cache key. With a key, a remount (e.g. switching modules and back) renders
   * the last result immediately and revalidates in the background; deps that
   * change without changing the key (a refresh tick) refetch without a
   * loading flash.
   */
  key?: string;
}

const cache = new Map<string, unknown>();
const CACHE_MAX = 300;

/** Forget every cached result, e.g. when the JetStream domain changes. */
export function clearAsyncCache(): void {
  cache.clear();
}

function remember(key: string, value: unknown) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.delete(key);
  cache.set(key, value);
}

/**
 * Runs an async loader whenever deps change. Return null from the loader to
 * skip (e.g. no connection selected). Stale responses are discarded.
 */
export function useAsync<T>(loader: () => Promise<T> | null, deps: unknown[], opts: Options = {}): AsyncState<T> {
  const key = opts.key ?? null;
  const cached = key !== null && cache.has(key) ? (cache.get(key) as T) : null;
  const [data, setDataState] = useState<T | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initial, setInitial] = useState(cached === null);
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const keyRef = useRef(key);
  keyRef.current = key;

  const setData = useCallback((updater: T | null | ((prev: T | null) => T | null)) => {
    setDataState(prev => {
      const next = typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater;
      if (keyRef.current !== null && next !== null) remember(keyRef.current, next);
      return next;
    });
  }, []);

  const run = useCallback(async () => {
    const p = loaderRef.current();
    if (!p) {
      seq.current++;
      setDataState(null);
      setError(null);
      setLoading(false);
      setInitial(true);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    try {
      const result = await p;
      if (id !== seq.current) return;
      if (keyRef.current !== null) remember(keyRef.current, result);
      setDataState(result);
      setError(null);
    } catch (err) {
      if (id !== seq.current) return;
      setError(errorMessage(err));
    } finally {
      if (id === seq.current) {
        setLoading(false);
        setInitial(false);
      }
    }
  }, []);

  useEffect(() => {
    const hit = key !== null && cache.has(key) ? (cache.get(key) as T) : null;
    if (hit !== null) {
      setDataState(hit);
      setInitial(false);
    } else {
      setInitial(true);
    }
    run();
    // biome-ignore lint/correctness/useExhaustiveDependencies: the list belongs to the caller of the hook
  }, deps);

  useEffect(() => {
    if (!opts.interval) return;
    const timer = setInterval(() => {
      if (opts.pauseHidden !== false && document.hidden) return;
      run();
    }, opts.interval);
    return () => clearInterval(timer);
  }, [opts.interval, opts.pauseHidden, run]);

  return { data, error, loading, initial, reload: run, setData };
}
