import { Router } from 'express';
import { z } from 'zod';
import { connectionStore } from '../nats/connection-manager.js';

export const consumersRouter: Router = Router();

function getJetStreamManager(connId: string) {
  const nc = connectionStore.getConnection(connId);
  if (!nc) throw new Error('Not connected');
  return nc.jetstreamManager();
}

consumersRouter.get('/streams/:stream/consumers', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    const consumers: any[] = [];
    const list = jsm.consumers.list(req.params.stream);
    for await (const ci of list) {
      consumers.push({
        name: ci.name,
        streamName: ci.stream_name,
        description: ci.config.description,
        created: ci.created,
        config: {
          name: ci.config.name,
          durableName: ci.config.durable_name,
          description: ci.config.description,
          deliverPolicy: ci.config.deliver_policy,
          ackPolicy: ci.config.ack_policy,
          ackWait: ci.config.ack_wait,
          maxDeliver: ci.config.max_deliver,
          filterSubject: ci.config.filter_subject,
          replayPolicy: ci.config.replay_policy,
          maxAckPending: ci.config.max_ack_pending,
        },
        delivered: ci.delivered,
        ackFloor: ci.ack_floor,
        numAckPending: ci.num_ack_pending,
        numRedelivered: ci.num_redelivered,
        numWaiting: ci.num_waiting,
        numPending: ci.num_pending,
      });
    }
    res.json(consumers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const consumerConfigSchema = z.object({
  name: z.string().optional(),
  durableName: z.string().optional(),
  description: z.string().optional(),
  deliverPolicy: z.enum(['all', 'last', 'new', 'by_start_sequence', 'by_start_time', 'last_per_subject']).optional(),
  optStartSeq: z.number().optional(),
  optStartTime: z.string().optional(),
  ackPolicy: z.enum(['none', 'all', 'explicit']).optional(),
  ackWait: z.number().optional(),
  maxDeliver: z.number().optional(),
  filterSubject: z.string().optional(),
  replayPolicy: z.enum(['instant', 'original']).optional(),
  maxAckPending: z.number().optional(),
  connId: z.string().optional(),
});

consumersRouter.post('/streams/:stream/consumers', async (req, res) => {
  try {
    const config = consumerConfigSchema.parse(req.body);
    const connId = (req.query.connId || config.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);

    const consumerConfig: any = {
      durable_name: config.durableName || config.name,
      ack_policy: config.ackPolicy || 'explicit',
    };
    if (config.description) consumerConfig.description = config.description;
    if (config.deliverPolicy) consumerConfig.deliver_policy = config.deliverPolicy;
    if (config.ackWait) consumerConfig.ack_wait = config.ackWait;
    if (config.maxDeliver) consumerConfig.max_deliver = config.maxDeliver;
    if (config.filterSubject) consumerConfig.filter_subject = config.filterSubject;
    if (config.replayPolicy) consumerConfig.replay_policy = config.replayPolicy;
    if (config.maxAckPending) consumerConfig.max_ack_pending = config.maxAckPending;

    const ci = await jsm.consumers.add(req.params.stream, consumerConfig);
    res.json({ success: true, name: ci.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

consumersRouter.get('/streams/:stream/consumers/:consumer', async (req, res) => {
  try {
    const connId = (req.query.connId || req.body?.connId) as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    const ci = await jsm.consumers.info(req.params.stream, req.params.consumer);
    res.json({
      name: ci.name,
      streamName: ci.stream_name,
      description: ci.config.description,
      created: ci.created,
      config: {
        name: ci.config.name,
        durableName: ci.config.durable_name,
        description: ci.config.description,
        deliverPolicy: ci.config.deliver_policy,
        ackPolicy: ci.config.ack_policy,
        ackWait: ci.config.ack_wait,
        maxDeliver: ci.config.max_deliver,
        filterSubject: ci.config.filter_subject,
        replayPolicy: ci.config.replay_policy,
        maxAckPending: ci.config.max_ack_pending,
        idleHeartbeat: ci.config.idle_heartbeat,
        flowControl: ci.config.flow_control,
        maxWaiting: ci.config.max_waiting,
        sampleFrequency: ci.config.sample_freq,
        inactiveThreshold: ci.config.inactive_threshold,
        backoff: ci.config.backoff,
        metadata: ci.config.metadata,
      },
      delivered: ci.delivered,
      ackFloor: ci.ack_floor,
      numAckPending: ci.num_ack_pending,
      numRedelivered: ci.num_redelivered,
      numWaiting: ci.num_waiting,
      numPending: ci.num_pending,
      pushBound: ci.push_bound,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

consumersRouter.delete('/streams/:stream/consumers/:consumer', async (req, res) => {
  try {
    const connId = req.query.connId as string;
    if (!connId) return res.status(400).json({ error: 'connId required' });
    const jsm = await getJetStreamManager(connId);
    await jsm.consumers.delete(req.params.stream, req.params.consumer);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
