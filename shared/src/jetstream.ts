export interface StreamInfo {
  name: string;
  description?: string;
  subjects: string[];
  retention: string;
  maxConsumers: number;
  maxMsgs: number;
  maxBytes: number;
  maxAge: number;
  maxMsgSize: number;
  storage: string;
  replicas: number;
  noAck: boolean;
  discard: string;
  duplicateWindow: number;
  state: StreamState;
}

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

export interface StreamConfig {
  name: string;
  description?: string;
  subjects: string[];
  retention?: 'limits' | 'interest' | 'workqueue';
  maxConsumers?: number;
  maxMsgs?: number;
  maxBytes?: number;
  maxAge?: number;
  maxMsgSize?: number;
  storage?: 'file' | 'memory';
  replicas?: number;
  noAck?: boolean;
  discard?: 'old' | 'new';
  duplicateWindow?: number;
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
}

export interface ConsumerConfig {
  name?: string;
  durableName?: string;
  description?: string;
  deliverPolicy?: 'all' | 'last' | 'new' | 'by_start_sequence' | 'by_start_time' | 'last_per_subject';
  optStartSeq?: number;
  optStartTime?: string;
  ackPolicy?: 'none' | 'all' | 'explicit';
  ackWait?: number;
  maxDeliver?: number;
  filterSubject?: string;
  replayPolicy?: 'instant' | 'original';
  maxAckPending?: number;
}

export interface SequenceInfo {
  consumerSeq: number;
  streamSeq: number;
}
