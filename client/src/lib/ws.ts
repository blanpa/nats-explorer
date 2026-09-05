import type { WsClientCommand, WsEventOf, WsEventType, WsServerEvent } from 'shared';
import { useAuth, withToken } from './auth';

type Listener<T extends WsEventType> = (event: WsEventOf<T>) => void;
type StatusListener = (status: WsStatus) => void;

export type WsStatus = 'connecting' | 'open' | 'closed';

/**
 * Thin auto-reconnecting websocket client. A manual disconnect suppresses the
 * reconnect so React StrictMode's double effect does not leave two sockets
 * behind. Commands sent while the socket is down are dropped; callers
 * re-issue them on the next 'open' status (see lib/live.ts).
 */
class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<WsEventType, Set<(event: WsServerEvent) => void>>();
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 15000;
  private manuallyClosed = false;
  status: WsStatus = 'closed';

  connect(): void {
    this.manuallyClosed = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(withToken(`${protocol}//${window.location.host}/ws`));
    this.ws = ws;
    this.setStatus('connecting');

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectDelay = 1000;
      this.setStatus('open');
    };
    ws.onmessage = event => {
      if (this.ws !== ws) return;
      let msg: WsServerEvent;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.listeners.get(msg.type)?.forEach(cb => cb(msg));
    };
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setStatus('closed');
      // 1008 = policy violation is what browsers report for a rejected upgrade (401).
      if (ev.code === 1008 || ev.code === 1006) {
        // Ask /api/auth whether a token is the reason before hammering reconnects.
        fetch('/api/auth')
          .then(r => r.json())
          .then((info: { required: boolean }) => {
            if (info.required && !useAuth.getState().token) useAuth.getState().setRequired(true);
          })
          .catch(() => undefined);
      }
      if (!this.manuallyClosed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    this.setStatus('closed');
  }

  /** Reconnect now (e.g. after a token was entered). */
  reset(): void {
    this.disconnect();
    this.reconnectDelay = 1000;
    this.connect();
  }

  send(cmd: WsClientCommand): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(cmd));
    return true;
  }

  on<T extends WsEventType>(type: T, callback: Listener<T>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const cb = callback as unknown as (event: WsServerEvent) => void;
    set.add(cb);
    return () => set!.delete(cb);
  }

  onStatus(callback: StatusListener): () => void {
    this.statusListeners.add(callback);
    callback(this.status);
    return () => this.statusListeners.delete(callback);
  }

  private setStatus(status: WsStatus) {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach(cb => cb(status));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }
}

export const wsClient = new WsClient();
