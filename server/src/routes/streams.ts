import { Router } from 'express';
import { z } from 'zod';
import { connectionStore } from '../nats/connection-manager.js';
import { StringCodec } from 'nats';

export const streamsRouter: Router = Router();
const sc = StringCodec();

function getJetStreamManager(connId: string) {
  const nc = connectionStore.getConnection(connId);
  if (!nc) throw new Error('Not connected');
  return nc.jetstreamManager();
}

function getJetStreamClient(connId: string) {
  const nc = connectionStore.getConnection(connId);
  if (!nc) throw new Error('Not connected');
  return nc.jetstream();
}

streamsRouter.get('/streams', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    const streams: any[] = [];
    const list = jsm.streams.list();
    for await (const si of list) {
      streams.push({
        name: si.config.name,
        description: si.config.description,
        subjects: si.config.subjects,
        retention: si.config.retention,
        maxConsumers: si.config.max_consumers,
        maxMsgs: si.config.max_msgs,
        maxBytes: si.config.max_bytes,
        maxAge: si.config.max_age,
        maxMsgSize: si.config.max_msg_size,
        storage: si.config.storage,
        replicas: si.config.num_replicas,
        noAck: si.config.no_ack,
        discard: si.config.discard,
        duplicateWindow: si.config.duplicate_window,
        state: {
          messages: si.state.messages,
          bytes: si.state.bytes,
          firstSeq: si.state.first_seq,
          lastSeq: si.state.last_seq,
          firstTs: si.state.first_ts,
          lastTs: si.state.last_ts,
          numSubjects: si.state.num_subjects,
          numDeleted: si.state.num_deleted,
          consumerCount: si.state.consumer_count,
        },
      });
    }
    res.json(streams);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const streamConfigSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  subjects: z.array(z.string()).min(1),
  retention: z.enum(['limits', 'interest', 'workqueue']).optional(),
  maxConsumers: z.number().optional(),
  maxMsgs: z.number().optional(),
  maxBytes: z.number().optional(),
  maxAge: z.number().optional(),
  maxMsgSize: z.number().optional(),
  storage: z.enum(['file', 'memory']).optional(),
  replicas: z.number().optional(),
  noAck: z.boolean().optional(),
  discard: z.enum(['old', 'new']).optional(),
  duplicateWindow: z.number().optional(),
  connId: z.string().optional(),
});

streamsRouter.post('/streams', async (req, res) => {
  try {
    const config = streamConfigSchema.parse(req.body);
    const connId = (req.query.connId || config.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);

    const streamConfig: any = {
      name: config.name,
      subjects: config.subjects,
    };
    if (config.description) streamConfig.description = config.description;
    if (config.retention) streamConfig.retention = config.retention;
    if (config.maxConsumers !== undefined) streamConfig.max_consumers = config.maxConsumers;
    if (config.maxMsgs !== undefined) streamConfig.max_msgs = config.maxMsgs;
    if (config.maxBytes !== undefined) streamConfig.max_bytes = config.maxBytes;
    if (config.maxAge !== undefined) streamConfig.max_age = config.maxAge;
    if (config.maxMsgSize !== undefined) streamConfig.max_msg_size = config.maxMsgSize;
    if (config.storage) streamConfig.storage = config.storage;
    if (config.replicas !== undefined) streamConfig.num_replicas = config.replicas;
    if (config.noAck !== undefined) streamConfig.no_ack = config.noAck;
    if (config.discard) streamConfig.discard = config.discard;
    if (config.duplicateWindow !== undefined) streamConfig.duplicate_window = config.duplicateWindow;

    const si = await jsm.streams.add(streamConfig);
    res.json({ success: true, name: si.config.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

streamsRouter.get('/streams/:name', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    const si = await jsm.streams.info(req.params.name);
    res.json({
      name: si.config.name,
      description: si.config.description,
      subjects: si.config.subjects,
      retention: si.config.retention,
      maxConsumers: si.config.max_consumers,
      maxMsgs: si.config.max_msgs,
      maxBytes: si.config.max_bytes,
      maxAge: si.config.max_age,
      maxMsgSize: si.config.max_msg_size,
      storage: si.config.storage,
      replicas: si.config.num_replicas,
      state: {
        messages: si.state.messages,
        bytes: si.state.bytes,
        firstSeq: si.state.first_seq,
        lastSeq: si.state.last_seq,
        firstTs: si.state.first_ts,
        lastTs: si.state.last_ts,
        numSubjects: si.state.num_subjects,
        numDeleted: si.state.num_deleted,
        consumerCount: si.state.consumer_count,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

streamsRouter.put('/streams/:name', async (req, res) => {
  try {
    const config = streamConfigSchema.parse(req.body);
    const connId = (req.query.connId || config.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    const si = await jsm.streams.info(req.params.name);

    const updateConfig: any = { ...si.config };
    if (config.subjects) updateConfig.subjects = config.subjects;
    if (config.description !== undefined) updateConfig.description = config.description;
    if (config.maxMsgs !== undefined) updateConfig.max_msgs = config.maxMsgs;
    if (config.maxBytes !== undefined) updateConfig.max_bytes = config.maxBytes;
    if (config.maxAge !== undefined) updateConfig.max_age = config.maxAge;
    if (config.maxMsgSize !== undefined) updateConfig.max_msg_size = config.maxMsgSize;

    const updated = await jsm.streams.update(req.params.name, updateConfig);
    res.json({ success: true, name: updated.config.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

streamsRouter.delete('/streams/:name', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    await jsm.streams.delete(req.params.name);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

streamsRouter.post('/streams/:name/purge', async (req, res) => {
  try {
    const connId = (req.query.connId || req.body?.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    const purged = await jsm.streams.purge(req.params.name);
    res.json({ success: true, purged: purged.purged });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

streamsRouter.delete('/streams/:name/messages/:seq', async (req, res) => {
  try {
    const connId = (req.query.connId || req.body?.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    const seq = parseInt(req.params.seq);
    await jsm.streams.deleteMessage(req.params.name, seq);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

streamsRouter.get('/streams/:name/messages', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const js = await getJetStreamClient(connId);
    const startSeq = parseInt(req.query.startSeq as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const jsm = await getJetStreamManager(connId);
    const si = await jsm.streams.info(req.params.name);

    const messages: any[] = [];

    // Use direct get for fetching messages by sequence
    for (let seq = startSeq; seq < startSeq + limit && seq <= si.state.last_seq; seq++) {
      try {
        const msg = await jsm.streams.getMessage(req.params.name, { seq });
        let payload: string;
        let payloadType: 'string' | 'json' | 'binary' = 'string';
        try {
          payload = sc.decode(msg.data);
          try { JSON.parse(payload); payloadType = 'json'; } catch {}
        } catch {
          payload = Buffer.from(msg.data).toString('base64');
          payloadType = 'binary';
        }
        messages.push({
          seq: msg.seq,
          subject: msg.subject,
          payload,
          payloadType,
          timestamp: msg.time ? new Date(msg.time).getTime() : Date.now(),
          size: msg.data?.length || 0,
        });
      } catch {
        // Message may have been deleted
      }
    }

    res.json({
      messages,
      total: si.state.messages,
      firstSeq: si.state.first_seq,
      lastSeq: si.state.last_seq,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
