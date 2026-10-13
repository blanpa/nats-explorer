import { useEffect, useState } from 'react';

/** Below this width the explorer and the detail no longer fit side by side. */
export const NARROW_QUERY = '(max-width: 767px)';

/** True on a narrow window: a phone, a tablet on the floor, a split screen. */
export function useNarrow(): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(NARROW_QUERY).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY);
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}
