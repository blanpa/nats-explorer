import { Subscription, NatsConnection, StringCodec } from 'nats';
import { EventEmitter } from 'events';
import { buildSubjectTree } from './subject-tree.js';
import type { NatsMessage, SubjectNode } from 'shared';

const sc = StringCodec();

interface SubjectStats {
  messageCount: number;
  lastMessage?: NatsMessage;
  recentTimestamps: number[];
}

// Throttle config
const MAX_MESSAGES_PER_SECOND_PER_SUBJECT = 10;
const MESSAGE_BATCH_INTERVAL_MS = 100;
const TREE_UPDATE_INTERVAL_MS = 500;

export class SubscriptionManager extends EventEmitter {
  private subs: Subscription[] = [];
  private subjectStats: Map<string, SubjectStats> = new Map();
  private treeUpdateTimer: NodeJS.Timeout | null = null;
  private batchTimer: NodeJS.Timeout | null = null;
  private nc: NatsConnection;
  public connId: string;
  public subjects: string[] = ['>'];

  // Throttling state
  private subjectEmitCounts: Map<string, number> = new Map();
  private throttleResetTimer: NodeJS.Timeout | null = null;
  private messageBatch: NatsMessage[] = [];
  private totalReceived = 0;
  private totalDropped = 0;

  constructor(nc: NatsConnection, connId: string) {
    super();
    this.nc = nc;
    this.connId = connId;
  }

  async startSubscriptions(subjects?: string[]): Promise<void> {
    this.stop();
    this.subjectStats.clear();
    this.subjectEmitCounts.clear();
    this.totalReceived = 0;
    this.totalDropped = 0;

    this.subjects = subjects && subjects.length > 0 ? subjects : ['>'];

    for (const subject of this.subjects) {
      const sub = this.nc.subscribe(subject);
      this.subs.push(sub);

      (async () => {
        for await (const msg of sub) {
          this.handleIncomingMessage(msg);
        }
      })().catch(() => {});
    }

    // Batch flush: send accumulated messages every 100ms
    this.batchTimer = setInterval(() => {
      this.flushBatch();
    }, MESSAGE_BATCH_INTERVAL_MS);

    // Tree updates every 500ms
    this.treeUpdateTimer = setInterval(() => {
      this.emit('tree', this.connId, this.getTree());
    }, TREE_UPDATE_INTERVAL_MS);

    // Reset per-subject throttle counters every second
    this.throttleResetTimer = setInterval(() => {
      this.subjectEmitCounts.clear();
    }, 1000);
  }

  stop(): void {
    for (const sub of this.subs) {
      try { sub.unsubscribe(); } catch {}
    }
    this.subs = [];
    if (this.treeUpdateTimer) { clearInterval(this.treeUpdateTimer); this.treeUpdateTimer = null; }
    if (this.batchTimer) { clearInterval(this.batchTimer); this.batchTimer = null; }
    if (this.throttleResetTimer) { clearInterval(this.throttleResetTimer); this.throttleResetTimer = null; }
    this.flushBatch();
  }

  getTree(): SubjectNode[] {
    return buildSubjectTree(this.subjectStats);
  }

  getStats() {
    return { totalReceived: this.totalReceived, totalDropped: this.totalDropped, subjects: this.subjectStats.size };
  }

  private handleIncomingMessage(msg: any): void {
    const natsMsg = this.convertMessage(msg);
    this.totalReceived++;

    // Always update stats (counts, tree) even if we drop the message for WS
    this.updateStats(natsMsg);

    // Throttle: max N messages per second per subject forwarded to browser
    const emitCount = this.subjectEmitCounts.get(natsMsg.subject) || 0;
    if (emitCount < MAX_MESSAGES_PER_SECOND_PER_SUBJECT) {
      this.subjectEmitCounts.set(natsMsg.subject, emitCount + 1);
      this.messageBatch.push(natsMsg);
    } else {
      this.totalDropped++;
    }
  }

  private flushBatch(): void {
    if (this.messageBatch.length === 0) return;

    const batch = this.messageBatch;
    this.messageBatch = [];

    // Emit as batch for efficient WS sending
    this.emit('message-batch', this.connId, batch);
  }

  private convertMessage(msg: any): NatsMessage {
    let payload: string;
    let payloadType: 'string' | 'json' | 'binary' = 'string';

    try {
      payload = sc.decode(msg.data);
      // Quick JSON check: only if starts with { or [ to avoid expensive parse
      if (payload.length > 0 && (payload[0] === '{' || payload[0] === '[')) {
        try { JSON.parse(payload); payloadType = 'json'; } catch {}
      }
    } catch {
      payload = Buffer.from(msg.data).toString('base64');
      payloadType = 'binary';
    }

    const hdrs: Record<string, string[]> | undefined = msg.headers
      ? (() => {
          const h: Record<string, string[]> = {};
          for (const [key, values] of msg.headers) { h[key] = values; }
          return h;
        })()
      : undefined;

    return {
      subject: msg.subject,
      payload,
      payloadType,
      headers: hdrs,
      timestamp: Date.now(),
      reply: msg.reply || undefined,
      size: msg.data?.length || 0,
    };
  }

  private updateStats(msg: NatsMessage): void {
    let stats = this.subjectStats.get(msg.subject);
    if (!stats) {
      stats = { messageCount: 0, recentTimestamps: [] };
      this.subjectStats.set(msg.subject, stats);
    }
    stats.messageCount++;
    stats.lastMessage = msg;
    const now = Date.now();
    stats.recentTimestamps.push(now);
    // Keep only last 10 seconds for rate calc, but use a cheaper approach
    if (stats.recentTimestamps.length > 200) {
      stats.recentTimestamps = stats.recentTimestamps.filter(t => now - t < 10000);
    }
  }
}
