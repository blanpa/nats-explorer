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
  /** "none" or "s2" */
  compression?: StreamCompression;
  /** "default" or "async" (NATS 2.12) */
  persistMode?: StreamPersistMode;
  /** the NATS 2.12 switches */
  allowMsgCounter?: boolean;
  allowAtomicPublish?: boolean;
  allowMsgSchedules?: boolean;
  /** a mirror that answers direct gets itself */
  mirrorDirect?: boolean;
  /** where the stream started counting */
  firstSeq?: number;
  republish?: RePublishConfig;
  subjectTransform?: SubjectTransformConfig;
  placement?: PlacementConfig;
  metadata?: Record<string, string>;
  consumerLimits?: { inactiveThreshold: number; maxAckPending: number };
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

export type StreamCompression = 'none' | 's2';
export type StreamPersistMode = 'default' | 'async';

/** Messages are published again on another subject as they are stored. */
export interface RePublishConfig {
  /** the subjects it applies to; empty is every subject of the stream */
  src?: string;
  dest: string;
  headersOnly?: boolean;
}

/** A subject mapping applied on the way in. */
export interface SubjectTransformConfig {
  src?: string;
  dest: string;
}

/** Which cluster, or which tagged servers, hold the stream. */
export interface PlacementConfig {
  cluster?: string;
  tags?: string[];
}

/** A mirror or a source as it is configured, with the state once data flows. */
export interface StreamSource {
  name: string;
  /** where the copy started, when it was told to */
  optStartSeq?: number;
  /** unix ms */
  optStartTime?: number;
  subjectTransforms?: SubjectTransformConfig[];
  /** a stream in another account or domain, by its API prefix */
  externalApi?: string;
  externalDeliver?: string;
  domain?: string;
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
  /** null or absent clears; an object sets */
  mirror?: StreamSource | null;
  sources?: StreamSource[];
  republish?: RePublishConfig | null;
  subjectTransform?: SubjectTransformConfig | null;
  placement?: PlacementConfig | null;
  metadata?: Record<string, string> | null;
  compression?: StreamCompression;
  persistMode?: StreamPersistMode;
  allowMsgCounter?: boolean;
  allowAtomicPublish?: boolean;
  allowMsgSchedules?: boolean;
  mirrorDirect?: boolean;
  /** create only */
  firstSeq?: number;
  consumerInactiveThreshold?: number;
  consumerMaxAckPending?: number;
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
  /** set when the page was narrowed to this subject */
  subject?: string;
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

export type DeliverPolicy = 'all' | 'last' | 'new' | 'by_start_sequence' | 'by_start_time' | 'last_per_subject';
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
  deliverGroup?: string;
  optStartSeq?: number;
  /** unix ms */
  optStartTime?: number;
  /** redelivery waits, nanoseconds, one per attempt */
  backoff?: number[];
  /** nanoseconds without a pull before the consumer is removed */
  inactiveThreshold?: number;
  maxWaiting?: number;
  headersOnly?: boolean;
  maxRequestBatch?: number;
  rateLimit?: number;
  replicas?: number;
  memoryStorage?: boolean;
  metadata?: Record<string, string>;
}

/** One message a pull consumer handed over on request, not acknowledged yet. */
export interface PulledMessage extends StreamMessage {
  /** the ack subject; what is said to it decides the message's fate */
  reply: string;
  deliveries?: number;
  consumerSeq?: number;
  /** messages behind this one */
  pending?: number;
}

export type AckAction = 'ack' | 'nak' | 'term' | 'progress';

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
  filterSubjects?: string[];
  backoff?: number[];
  inactiveThreshold?: number;
  maxWaiting?: number;
  headersOnly?: boolean;
  maxRequestBatch?: number;
  rateLimit?: number;
  metadata?: Record<string, string>;
  deliverSubject?: string;
  deliverGroup?: string;
}

export interface ConsumerCreateInput {
  name?: string;
  durableName?: string;
  description?: string;
  deliverPolicy?: DeliverPolicy;
  optStartSeq?: number;
  /** unix ms, for by_start_time */
  optStartTime?: number;
  ackPolicy?: AckPolicy;
  ackWait?: number;
  maxDeliver?: number;
  filterSubject?: string;
  filterSubjects?: string[];
  replayPolicy?: ReplayPolicy;
  maxAckPending?: number;
  backoff?: number[];
  inactiveThreshold?: number;
  maxWaiting?: number;
  headersOnly?: boolean;
  maxRequestBatch?: number;
  rateLimit?: number;
  replicas?: number;
  memoryStorage?: boolean;
  metadata?: Record<string, string>;
  /** a deliver subject makes it a push consumer */
  deliverSubject?: string;
  deliverGroup?: string;
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
