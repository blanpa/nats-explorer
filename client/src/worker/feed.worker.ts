/// <reference lib="webworker" />
import { decode } from '@msgpack/msgpack';
import type { WsClientCommand, WsServerEvent } from 'shared';
import { FeedCore } from './feedCore';
import type { FromWorker, ToWorker, WsStatus } from './protocol';

/**
 * The feed worker owns the websocket. It decodes frames (JSON or
 * MessagePack) and hands them to FeedCore, which keeps the subject tree of
 * every connection, lays the rows out for the tab's view and coalesces live
 * messages, so the main thread only receives render-ready data.
 */

const post = (msg: FromWorker) => self.postMessage(msg);
const core = new FeedCore(post);

let ws: WebSocket | null = null;
let url = '';
/** Where to ask whether a rejected upgrade was an authentication problem. */
let authUrl = '/api/auth';
let binary = true;
let status: WsStatus = 'closed';
let manuallyClosed = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const maxReconnectDelay = 15_000;

function setStatus(next: WsStatus) {
  if (status === next) return;
  status = next;
  post({ type: 'status', status });
}

function send(cmd: WsClientCommand): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(cmd));
  return true;
}

function sendView() {
  const { view } = core;
  send({ type: 'view', all: view.all, paths: view.paths, filter: view.filter, expr: view.expr, noPreview: !view.preview });
}

function decodeFrame(data: unknown): WsServerEvent | null {
  try {
    if (data instanceof ArrayBuffer) return decode(new Uint8Array(data)) as WsServerEvent;
    if (typeof data === 'string') return JSON.parse(data) as WsServerEvent;
  } catch {
    /* ignore malformed frames */
  }
  return null;
}

function connect() {
  manuallyClosed = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const sock = new WebSocket(binary ? `${url}${url.includes('?') ? '&' : '?'}enc=msgpack` : url);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  setStatus('connecting');

  sock.onopen = () => {
    if (ws !== sock) return;
    reconnectDelay = 1000;
    // Snapshot of the previous view drops with the socket: start from what the tab shows now.
    core.reset();
    sendView();
    setStatus('open');
  };
  sock.onmessage = ev => {
    if (ws !== sock) return;
    const msg = decodeFrame(ev.data);
    if (msg) core.handleEvent(msg);
  };
  sock.onclose = ev => {
    if (ws !== sock) return;
    ws = null;
    setStatus('closed');
    // 1008 = policy violation is what browsers report for a rejected upgrade (401).
    if (ev.code === 1008 || ev.code === 1006) {
      fetch(authUrl)
        .then(r => r.json())
        .then((info: { authenticated: boolean }) => {
          if (!info.authenticated) post({ type: 'auth-required' });
        })
        .catch(() => undefined);
    }
    if (!manuallyClosed) scheduleReconnect();
  };
  sock.onerror = () => sock.close();
}

function disconnect() {
  manuallyClosed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const sock = ws;
  ws = null;
  if (sock) {
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    sock.close();
  }
  setStatus('closed');
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
    connect();
  }, reconnectDelay);
}

/* Commands from the main thread ------------------------------------------ */

let viewTimer: ReturnType<typeof setTimeout> | null = null;

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'connect':
      if (url !== msg.url || binary !== msg.binary) disconnect();
      url = msg.url;
      binary = msg.binary;
      authUrl = msg.authUrl;
      reconnectDelay = 1000;
      connect();
      break;
    case 'disconnect':
      disconnect();
      break;
    case 'send':
      send(msg.cmd);
      break;
    case 'view': {
      const filterChanged = msg.view.filter !== core.view.filter;
      core.view = msg.view;
      core.layoutTree();
      // Expansion is sent at once; typing into the filter is debounced.
      if (viewTimer) clearTimeout(viewTimer);
      if (filterChanged) viewTimer = setTimeout(sendView, 50);
      else sendView();
      break;
    }
  }
};
