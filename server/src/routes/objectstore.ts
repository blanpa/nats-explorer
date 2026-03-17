import { Router } from 'express';
import { z } from 'zod';
import { connectionStore } from '../nats/connection-manager.js';

export const objectStoreRouter: Router = Router();

async function getJetStream(connId: string) {
  const nc = connectionStore.getConnection(connId);
  if (!nc) throw new Error('Not connected');
  return nc.jetstream();
}

objectStoreRouter.get('/objectstore', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) return res.status(400).json({ error: 'Not connected' });

    const jsm = await nc.jetstreamManager();
    const stores: any[] = [];
    const streams = jsm.streams.list();
    for await (const si of streams) {
      if (si.config.name.startsWith('OBJ_')) {
        const storeName = si.config.name.slice(4);
        stores.push({
          bucket: storeName,
          description: si.config.description,
          size: si.state.bytes,
          storage: si.config.storage,
          sealed: false,
          replicas: si.config.num_replicas,
          chunks: si.state.messages,
          backingStreamName: si.config.name,
        });
      }
    }
    res.json(stores);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const objStoreSchema = z.object({
  bucket: z.string().min(1),
  description: z.string().optional(),
  maxChunkSize: z.number().optional(),
  maxBytes: z.number().optional(),
  storage: z.enum(['file', 'memory']).optional(),
  replicas: z.number().optional(),
  ttl: z.number().optional(),
  connId: z.string().optional(),
});

objectStoreRouter.post('/objectstore', async (req, res) => {
  try {
    const config = objStoreSchema.parse(req.body);
    const connId = (req.query.connId || config.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);

    const opts: any = {};
    if (config.description) opts.description = config.description;
    if (config.maxChunkSize) opts.max_chunk_size = config.maxChunkSize;
    if (config.maxBytes) opts.max_bytes = config.maxBytes;
    if (config.storage) opts.storage = config.storage;
    if (config.replicas) opts.num_replicas = config.replicas;
    if (config.ttl) opts.ttl = config.ttl;

    const os = await js.views.os(config.bucket, opts);
    res.json({ success: true, bucket: config.bucket });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

objectStoreRouter.get('/objectstore/:store', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);
    const os = await js.views.os(req.params.store);

    const objects: any[] = [];
    const list = await os.list();
    for await (const obj of list) {
      objects.push({
        name: obj.name,
        description: obj.description,
        size: obj.size,
        chunks: obj.chunks,
        nuid: obj.nuid,
        digest: obj.digest,
        deleted: obj.deleted,
        mtime: obj.mtime,
      });
    }
    res.json(objects);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

objectStoreRouter.get('/objectstore/:store/:name', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);
    const os = await js.views.os(req.params.store);

    const result = await os.get(req.params.name);
    if (!result) {
      return res.status(404).json({ error: 'Object not found' });
    }

    // Read the data from the readable stream
    const chunks: Uint8Array[] = [];
    const reader = result.data.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const data = Buffer.concat(chunks);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.send(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload object - accepts JSON with base64-encoded data
objectStoreRouter.put('/objectstore/:store/:name', async (req, res) => {
  try {
    const connId = (req.query.connId || req.body?.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const nc = connectionStore.getConnection(connId);
    if (!nc) return res.status(400).json({ error: 'Not connected' });
    const js = nc.jetstream();
    const os = await js.views.os(req.params.store);

    const { data, description } = req.body;
    if (!data) return res.status(400).json({ error: 'data (base64) required' });

    const buffer = Buffer.from(data, 'base64');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      }
    });

    const putOpts: any = { name: req.params.name };
    if (description) putOpts.description = description;

    const info = await os.put(putOpts, stream);
    res.json({ success: true, name: req.params.name, size: info.size, chunks: info.chunks });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

objectStoreRouter.delete('/objectstore/:store/:name', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStream(connId);
    const os = await js.views.os(req.params.store);
    await os.delete(req.params.name);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
