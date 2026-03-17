import { Router } from 'express';
import { z } from 'zod';
import { connectionStore } from '../nats/connection-manager.js';
import type { ConnectionConfig } from 'shared';

export const connectionRouter: Router = Router();

const connectSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  servers: z.array(z.string()).min(1),
  authMethod: z.enum(['none', 'token', 'userpass', 'nkey', 'jwt']).default('none'),
  token: z.string().optional(),
  user: z.string().optional(),
  pass: z.string().optional(),
  nkeySeed: z.string().optional(),
  creds: z.string().optional(),
  tls: z.boolean().optional(),
  subscriptions: z.array(z.string()).optional(),
  monitoringPort: z.number().optional(),
  monitoringUrl: z.string().optional(),
});

connectionRouter.post('/connect', async (req, res) => {
  try {
    const config = connectSchema.parse(req.body);
    const connConfig: ConnectionConfig = {
      id: config.id || crypto.randomUUID(),
      name: config.name || config.servers[0],
      servers: config.servers,
      authMethod: config.authMethod,
      token: config.token,
      user: config.user,
      pass: config.pass,
      nkeySeed: config.nkeySeed,
      creds: config.creds,
      tls: config.tls,
      subscriptions: config.subscriptions,
      monitoringPort: config.monitoringPort,
      monitoringUrl: config.monitoringUrl,
    };

    const managed = await connectionStore.connect(connConfig);
    await managed.subscriptionManager.startSubscriptions(connConfig.subscriptions);

    res.json({ success: true, id: connConfig.id, status: connectionStore.getStatus(connConfig.id) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

connectionRouter.post('/disconnect', async (req, res) => {
  try {
    const { connId } = z.object({ connId: z.string() }).parse(req.body);
    await connectionStore.disconnect(connId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

connectionRouter.post('/disconnect-all', async (req, res) => {
  try {
    await connectionStore.disconnectAll();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

connectionRouter.get('/connections', (req, res) => {
  res.json(connectionStore.getAllStatuses());
});

connectionRouter.get('/status', (req, res) => {
  const connId = req.query.connId as string;
  if (connId) {
    res.json(connectionStore.getStatus(connId));
  } else {
    res.json(connectionStore.getAllStatuses());
  }
});

connectionRouter.get('/cluster/:connId', async (req, res) => {
  try {
    const info = await connectionStore.getClusterInfo(req.params.connId);
    if (!info) {
      return res.status(404).json({ error: 'Connection not found or not connected' });
    }
    res.json(info);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
