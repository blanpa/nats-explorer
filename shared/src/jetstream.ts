import type { Aggregation, PayloadType } from './messages.js';

export type RetentionPolicy = 'limits' | 'interest' | 'workqueue';
export type StorageType = 'file' | 'memory';
export type DiscardPolicy = 'old' | 'new';

export interface StreamState {
  messages: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
  firstTs: string;
  lastTs: string;
  numSubjects: number;
  numDeleted: number;
  consumerCount: number;
}

export interface StreamReplica {
  name: string;
  current: boolean;
  offline: boolean;
  lag: number;
}

export interface StreamInfo {
  name: string;
  description?: string;
  subjects: string[];
  retention: string;
  maxConsumers: number;
  maxMsgs: number;
  maxMsgsPerSubject: number;
  maxBytes: number;
  /** nanoseconds, 0 = unlimited */
  maxAge: number;
  maxMsgSize: number;
  storage: string;
  replicas: number;
  noAck: boolean;
  discard: string;
  duplicateWindow: number;
  denyDelete: boolean;
  denyPurge: boolean;
  /** the "new" discard policy applies per subject (NATS 2.11) */
  discardNewPerSubject?: boolean;
  /** publishers may expire their own messages with a Nats-TTL header (NATS 2.11) */
  allowMsgTtl?: boolean;
  /** how long a delete marker stays after a subject's last message, ns */
  subjectDeleteMarkerTtl?: number;
  allowRollup: boolean;
  allowDirect: boolean;
  sealed: boolean;
  created: string;
  state: StreamState;
  cluster?: { name: string; leader: string; replicas: StreamReplica[] };
  /** the stream this one mirrors, with its lag once data flows */
  mirror?: StreamSource;
  /** the streams this one sources from */
  sources?: StreamSource[];
  /** which other streams mirror or source from this one; only the listing knows this */
  sourcedBy?: { name: string; kind: 'mirror' | 'source' }[];
}

/** One replication relation of a stream. */
export interface StreamSource {
  name: string;
  /** messages this side is behind; only meaningful while there is traffic */
  lag?: number;
  /** milliseconds since the last activity; -1 before anything happened */
  active?: number;
  filterSubject?: string;
}

/** Fields accepted by POST/PUT /api/streams. Omitted fields keep their value. */
export interface StreamConfigInput {
  name?: string;
  description?: string;
  subjects?: string[];
  retention?: RetentionPolicy;
  maxConsumers?: number;
  maxMsgs?: number;
  maxMsgsPerSubject?: number;
  maxBytes?: number;
  maxAge?: number;
  maxMsgSize?: number;
  storage?: StorageType;
  replicas?: number;
  noAck?: boolean;
  discard?: DiscardPolicy;
  duplicateWindow?: number;
  denyDelete?: boolean;
  denyPurge?: boolean;
  discardNewPerSubject?: boolean;
  allowMsgTtl?: boolean;
  subjectDeleteMarkerTtl?: number;
  allowRollup?: boolean;
  allowDirect?: boolean;
}

export interface StreamMessage {
  seq: number;
  subject: string;
  payload: string;
  payloadType: PayloadType;
  timestamp: number;
  size: number;
  headers?: Record<string, string[]>;
}

export interface StreamMessagesPage {
  messages: StreamMessage[];
  total: number;
  firstSeq: number;
  lastSeq: number;
  pageStart: number;
  pageEnd: number;
}

/** GET /api/streams/{name}/series: a numeric JSON field over a stream's last messages, downsampled. */
export interface StreamSeries {
  stream: string;
  field: string;
  subject?: string;
  /** [timestamp ms, value] in time order, reduced per bucket the way `agg` says */
  points: [number, number][];
  agg?: Aggregation;
  samples: number;
  scanned: number;
  fromSeq: number;
  toSeq: number;
}

export type DeliverPolicy = 'all' | 'last' | 'new' | 'by_start_sequence' | 'last_per_subject';
export type AckPolicy = 'none' | 'all' | 'explicit';
export type ReplayPolicy = 'instant' | 'original';

export interface ConsumerConfig {
  name?: string;
  durableName?: string;
  description?: string;
  deliverPolicy: string;
  ackPolicy: string;
  ackWait: number;
  maxDeliver: number;
  filterSubject?: string;
  filterSubjects?: string[];
  replayPolicy: string;
  maxAckPending: number;
  deliverSubject?: string;
  optStartSeq?: number;
}

export interface SequenceInfo {
  consumerSeq: number;
  streamSeq: number;
}

export interface ConsumerInfo {
  name: string;
  streamName: string;
  description?: string;
  created: string;
  config: ConsumerConfig;
  delivered: SequenceInfo;
  ackFloor: SequenceInfo;
  numAckPending: number;
  numRedelivered: number;
  numWaiting: number;
  numPending: number;
  push: boolean;
  /** the consumer is paused and delivers nothing until its deadline */
  paused?: boolean;
  /** milliseconds left of the pause */
  pauseRemaining?: number;
}

/** PUT /api/streams/{stream}/consumers/{name}: the fields JetStream lets you change after creation. */
export interface ConsumerUpdateInput {
  description?: string;
  /** nanoseconds */
  ackWait?: number;
  maxDeliver?: number;
  maxAckPending?: number;
  filterSubject?: string;
}

export interface ConsumerCreateInput {
  name?: string;
  durableName?: string;
  description?: string;
  deliverPolicy?: DeliverPolicy;
  optStartSeq?: number;
  ackPolicy?: AckPolicy;
  ackWait?: number;
  maxDeliver?: number;
  filterSubject?: string;
  replayPolicy?: ReplayPolicy;
  maxAckPending?: number;
}

/** A stream that would store a subject, and the consumers that would see it. */
export interface MatchStream {
  name: string;
  /** the stream's own patterns that match */
  subjects: string[];
  consumers: MatchConsumer[];
  /** consumers of the stream whose filter does not match */
  filtered: number;
}

export interface MatchConsumer {
  name: string;
  /** its filters that match; empty means it has none and takes everything */
  subjects?: string[];
  push?: boolean;
}

/** What one concrete subject runs into: GET /api/match?subject= */
export interface MatchResponse {
  subject: string;
  streams: MatchStream[];
  /** the pinned schema that would judge it */
  schemaPattern?: string;
  /** whether the streams could be read at all */
  jetStream: boolean;
  error?: string;
}

/** A run of sequences a stream does not have, inclusive. */
export interface GapRange {
  from: number;
  to: number;
}

/** Where a stream's sequences are missing: GET /api/streams/{name}/gaps */
export interface StreamGaps {
  stream: string;
  firstSeq: number;
  lastSeq: number;
  messages: number;
  /** how many sequences between first and last are not stored */
  missing: number;
  ranges: GapRange[];
  /** whether ranges covers all of them */
  listed: boolean;
}
