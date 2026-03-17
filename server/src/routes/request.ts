import { Router } from 'express';
import { z } from 'zod';
import { StringCodec, headers as createHeaders } from 'nats';
import { connectionStore } from '../nats/connection-manager.js';

export const requestRouter: Router = Router();
const sc = StringCodec();

const requestSchema = z.object({
  subject: z.string().min(1),
  payload: z.string(),
  timeout: z.number().default(5000),
  headers: z.record(z.string(), z.array(z.string())).optional(),
  connId: z.string().optional(),
});

requestRouter.post('/request', async (req, res) => {
  try {
    const { subject, payload, timeout, headers, connId: bodyConnId } = requestSchema.parse(req.body);
    const connId = (req.query.connId || bodyConnId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) {
      return res.status(400).json({ error: 'Not connected' });
    }

    const opts: any = { timeout };
    if (headers && Object.keys(headers).length > 0) {
      const hdrs = createHeaders();
      for (const [key, values] of Object.entries(headers)) {
        for (const v of values) {
          hdrs.append(key, v);
        }
      }
      opts.headers = hdrs;
    }

    const response = await nc.request(subject, sc.encode(payload), opts);

    let responsePayload: string;
    let payloadType: 'string' | 'json' | 'binary' = 'string';
    try {
      responsePayload = sc.decode(response.data);
      try {
        JSON.parse(responsePayload);
        payloadType = 'json';
      } catch {}
    } catch {
      responsePayload = Buffer.from(response.data).toString('base64');
      payloadType = 'binary';
    }

    res.json({
      subject: response.subject,
      payload: responsePayload,
      payloadType,
      reply: response.reply,
      size: response.data?.length || 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
