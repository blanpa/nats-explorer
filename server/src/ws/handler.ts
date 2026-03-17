import { WebSocket } from 'ws';
import { connectionStore } from '../nats/connection-manager.js';

const clients = new Set<WebSocket>();

// Pre-stringify reusable parts to reduce serialization overhead
const WS_BUFFER_HIGH_WATER = 64 * 1024; // 64KB backpressure threshold

export function handleWebSocket(ws: WebSocket): void {
  clients.add(ws);

  // Send current state for all connections
  const statuses = connectionStore.getAllStatuses();
  sendToClient(ws, { type: 'connections', data: statuses });

  // Send current trees for all active connections
  for (const managed of connectionStore.getAll()) {
    const tree = managed.subscriptionManager.getTree();
    if (tree.length > 0) {
      sendToClient(ws, { type: 'subject-tree', connId: managed.id, data: tree });
    }
  }

  ws.on('message', (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      // Handle client events if needed
    } catch {
      sendToClient(ws, { type: 'error', data: { message: 'Invalid message format' } });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
}

function sendToClient(ws: WebSocket, event: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    // Backpressure: skip if buffer is full
    if (ws.bufferedAmount > WS_BUFFER_HIGH_WATER) return;
    ws.send(JSON.stringify(event));
  }
}

function broadcastToAll(event: any): void {
  if (clients.size === 0) return;
  const data = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && client.bufferedAmount <= WS_BUFFER_HIGH_WATER) {
      client.send(data);
    }
  }
}

// Wire up a newly added connection's subscription manager
function wireConnection(connId: string) {
  const managed = connectionStore.get(connId);
  if (!managed) return;

  // Batched messages: receive array of messages, send as single WS frame
  managed.subscriptionManager.on('message-batch', (cId: string, batch: any[]) => {
    if (clients.size === 0) return;
    // Send batch as a single event to reduce WS frame overhead
    const data = JSON.stringify({ type: 'message-batch', connId: cId, data: batch });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN && client.bufferedAmount <= WS_BUFFER_HIGH_WATER) {
        client.send(data);
      }
    }
  });

  managed.subscriptionManager.on('tree', (cId: string, tree: any) => {
    broadcastToAll({ type: 'subject-tree', connId: cId, data: tree });
  });
}

// Wire up connection store events
connectionStore.on('connection-added', (connId: string) => {
  wireConnection(connId);
  broadcastToAll({ type: 'connections', data: connectionStore.getAllStatuses() });
});

connectionStore.on('connection-removed', (connId: string) => {
  broadcastToAll({ type: 'connections', data: connectionStore.getAllStatuses() });
});

connectionStore.on('status-change', (connId: string, status: any) => {
  broadcastToAll({ type: 'connection-status', connId, data: status });
});
