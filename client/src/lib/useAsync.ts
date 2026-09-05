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
}

/**
 * Runs an async loader whenever deps change. Return null from the loader to
 * skip (e.g. no connection selected). Stale responses are discarded.
 */
export function useAsync<T>(loader: () => Promise<T> | null, deps: unknown[], opts: Options = {}): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initial, setInitial] = useState(true);
  const seq = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(async () => {
    const p = loaderRef.current();
    if (!p) {
      seq.current++;
      setData(null);
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
      setData(result);
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
    setInitial(true);
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
