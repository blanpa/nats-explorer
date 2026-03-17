import { Router } from 'express';
import { StringCodec } from 'nats';
import { connectionStore } from '../nats/connection-manager.js';

export const servicesRouter: Router = Router();
const sc = StringCodec();

// Discover all services via $SRV.INFO
servicesRouter.get('/services', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) return res.status(400).json({ error: 'Not connected' });

    const services: any[] = [];
    const sub = nc.subscribe('$SRV.INFO', { max: 50, timeout: 3000 });

    // Request service info
    nc.publish('$SRV.INFO', undefined);

    try {
      for await (const msg of sub) {
        try {
          const info = JSON.parse(sc.decode(msg.data));
          services.push(info);
        } catch {}
      }
    } catch {
      // Timeout is expected
    }

    res.json(services);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get stats for all services via $SRV.STATS
servicesRouter.get('/services/stats', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) return res.status(400).json({ error: 'Not connected' });

    const stats: any[] = [];
    const sub = nc.subscribe('$SRV.STATS', { max: 50, timeout: 3000 });

    nc.publish('$SRV.STATS', undefined);

    try {
      for await (const msg of sub) {
        try {
          const stat = JSON.parse(sc.decode(msg.data));
          stats.push(stat);
        } catch {}
      }
    } catch {}

    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Ping all services via $SRV.PING
servicesRouter.get('/services/ping', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) return res.status(400).json({ error: 'Not connected' });

    const pongs: any[] = [];
    const sub = nc.subscribe('$SRV.PING', { max: 50, timeout: 2000 });

    nc.publish('$SRV.PING', undefined);

    try {
      for await (const msg of sub) {
        try {
          const pong = JSON.parse(sc.decode(msg.data));
          pongs.push(pong);
        } catch {}
      }
    } catch {}

    res.json(pongs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
