import { Router } from 'express';
import { z } from 'zod';
import { StringCodec } from 'nats';
import { connectionStore } from '../nats/connection-manager.js';

export const kvRouter: Router = Router();
const sc = StringCodec();

async function getJetStream(connId: string) {
  const nc = connectionStore.getConnection(connId);
  if (!nc) throw new Error('Not connected');
  return nc.jetstream();
}

kvRouter.get('/kv', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) return res.status(400).json({ error: 'Not connected' });

    const jsm = await nc.jetstreamManager();
    const buckets: any[] = [];
    const streams = jsm.streams.list();
    for await (const si of streams) {
      if (si.config.name.startsWith('KV_')) {
        const bucketName = si.config.name.slice(3);
        buckets.push({
          bucket: bucketName,
          description: si.config.description,
          values: si.state.messages,
          history: si.config.max_msgs_per_subject || 1,
          ttl: si.config.max_age || 0,
          maxValueSize: si.config.max_msg_size || -1,
          maxBytes: si.config.max_bytes || -1,
          storage: si.config.storage,
          replicas: si.config.num_replicas,
          bytes: si.state.bytes,
          backingStreamName: si.config.name,
        });
      }
    }
    res.json(buckets);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const kvBucketSchema = z.object({
  bucket: z.string().min(1),
  description: z.string().optional(),
  history: z.number().optional(),
  ttl: z.number().optional(),
  maxValueSize: z.number().optional(),
  maxBytes: z.number().optional(),
  storage: z.enum(['file', 'memory']).optional(),
  replicas: z.number().optional(),
  connId: z.string().optional(),
});

kvRouter.post('/kv', async (req, res) => {
  try {
    const config = kvBucketSchema.parse(req.body);
    const connId = (req.query.connId || config.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);

    const opts: any = {};
    if (config.description) opts.description = config.description;
    if (config.history) opts.history = config.history;
    if (config.ttl) opts.ttl = config.ttl;
    if (config.maxValueSize) opts.max_value_size = config.maxValueSize;
    if (config.maxBytes) opts.max_bytes = config.maxBytes;
    if (config.storage) opts.storage = config.storage;
    if (config.replicas) opts.num_replicas = config.replicas;

    const kv = await js.views.kv(config.bucket, opts);
    res.json({ success: true, bucket: config.bucket });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

kvRouter.get('/kv/:bucket', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);
    const kv = await js.views.kv(req.params.bucket);

    const keys: string[] = [];
    const keyList = await kv.keys();
    for await (const key of keyList) {
      keys.push(key);
    }
    res.json(keys);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get bucket status/info
kvRouter.get('/kv/:bucket/status', async (req, res) => {
  try {
    const connId = (req.query.connId || req.body?.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) return res.status(400).json({ error: 'Not connected' });
    const js = nc.jetstream();
    const kv = await js.views.kv(req.params.bucket);
    const status = await kv.status();
    res.json({
      bucket: status.bucket,
      values: status.values,
      history: status.history,
      ttl: status.ttl,
      streamInfo: status.streamInfo,
      backingStreamName: status.backingStore,
      bytes: (status as any).bytes,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

kvRouter.get('/kv/:bucket/:key', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);
    const kv = await js.views.kv(req.params.bucket);

    const entry = await kv.get(req.params.key);
    if (!entry || entry.operation === 'DEL' || entry.operation === 'PURGE') {
      return res.status(404).json({ error: 'Key not found' });
    }

    let value: string;
    try {
      value = sc.decode(entry.value);
    } catch {
      value = Buffer.from(entry.value).toString('base64');
    }

    // Get history
    const history: any[] = [];
    const historyIter = await kv.history({ key: req.params.key });
    for await (const h of historyIter) {
      let hValue: string;
      try {
        hValue = h.value ? sc.decode(h.value) : '';
      } catch {
        hValue = h.value ? Buffer.from(h.value).toString('base64') : '';
      }
      history.push({
        bucket: req.params.bucket,
        key: h.key,
        value: hValue,
        revision: h.revision,
        created: h.created.toISOString(),
        operation: h.operation?.toLowerCase() || 'put',
      });
    }

    res.json({
      bucket: req.params.bucket,
      key: entry.key,
      value,
      revision: entry.revision,
      created: entry.created.toISOString(),
      operation: 'put',
      history,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

kvRouter.put('/kv/:bucket/:key', async (req, res) => {
  try {
    const connId = (req.query.connId || req.body?.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const { value } = z.object({ value: z.string() }).parse(req.body);
    const js = await getJetStream(connId);
    const kv = await js.views.kv(req.params.bucket);

    const revision = await kv.put(req.params.key, sc.encode(value));
    res.json({ success: true, revision });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Purge a specific key (remove all revisions)
kvRouter.post('/kv/:bucket/:key/purge', async (req, res) => {
  try {
    const connId = (req.query.connId || req.body?.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) return res.status(400).json({ error: 'Not connected' });
    const js = nc.jetstream();
    const kv = await js.views.kv(req.params.bucket);
    await kv.purge(req.params.key);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

kvRouter.delete('/kv/:bucket/:key', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);
    const kv = await js.views.kv(req.params.bucket);
    await kv.delete(req.params.key);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

kvRouter.delete('/kv/:bucket', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);
    const kv = await js.views.kv(req.params.bucket);
    await kv.destroy();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
