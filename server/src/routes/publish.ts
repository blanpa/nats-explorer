import { Router } from 'express';
import { z } from 'zod';
import { StringCodec, headers as createHeaders } from 'nats';
import { connectionStore } from '../nats/connection-manager.js';

export const publishRouter: Router = Router();
const sc = StringCodec();

const publishSchema = z.object({
  subject: z.string().min(1),
  payload: z.string(),
  headers: z.record(z.string(), z.array(z.string())).optional(),
  connId: z.string().optional(),
});

publishRouter.post('/publish', async (req, res) => {
  try {
    const { subject, payload, headers, connId: bodyConnId } = publishSchema.parse(req.body);
    const connId = (req.query.connId || bodyConnId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) {
      return res.status(400).json({ error: 'Not connected' });
    }

    const opts: any = {};
    if (headers && Object.keys(headers).length > 0) {
      const hdrs = createHeaders();
      for (const [key, values] of Object.entries(headers)) {
        for (const v of values) {
          hdrs.append(key, v);
        }
      }
      opts.headers = hdrs;
    }

    nc.publish(subject, sc.encode(payload), opts);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
