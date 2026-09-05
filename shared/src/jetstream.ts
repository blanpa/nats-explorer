import type { PayloadType } from './messages.js';

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
  allowRollup: boolean;
  allowDirect: boolean;
  sealed: boolean;
  created: string;
  state: StreamState;
  cluster?: { name: string; leader: string; replicas: StreamReplica[] };
  mirror?: string;
  sources?: string[];
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
