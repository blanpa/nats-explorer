import { useEffect, useRef } from 'react';
import type { WsClientCommand, WsEventOf, WsEventType } from 'shared';
import { wsClient } from './ws';

/**
 * Keeps a server-side live watch alive for the lifetime of a component: the
 * start command is (re)sent whenever the socket opens, the stop command on
 * unmount. Events of `eventType` are passed to `onEvent`.
 */
export function useLiveWatch<T extends WsEventType>(
  start: WsClientCommand | null,
  stop: WsClientCommand | null,
  eventType: T,
  onEvent: (event: WsEventOf<T>) => void,
) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const key = start ? JSON.stringify(start) : '';

  useEffect(() => {
    if (!start || !stop) return;
    const unsubStatus = wsClient.onStatus(status => {
      if (status === 'open') wsClient.send(start);
    });
    const unsubEvent = wsClient.on(eventType, e => handler.current(e));
    return () => {
      unsubStatus();
      unsubEvent();
      wsClient.send(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, eventType]);
}
