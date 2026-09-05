export type PayloadType = 'string' | 'json' | 'binary';

/** A message as delivered to the browser. Binary payloads are base64. */
export interface NatsMessage {
  subject: string;
  payload: string;
  payloadType: PayloadType;
  headers?: Record<string, string[]>;
  timestamp: number;
  reply?: string;
  size: number;
  sequence?: number;
  /** Set client-side to remember which connection delivered the message. */
  connId?: string;
}

export interface SubjectNode {
  segment: string;
  fullSubject: string;
  messageCount: number;
  lastMessage?: NatsMessage;
  children: SubjectNode[];
  rate: number;
}

export interface SubscriptionStats {
  received: number;
  dropped: number;
  subjects: number;
}

export interface PublishInput {
  subject: string;
  payload: string;
  headers?: Record<string, string[]>;
}

export interface RequestInput extends PublishInput {
  timeout?: number;
}

export interface RequestReply {
  subject: string;
  payload: string;
  payloadType: PayloadType;
  reply?: string;
  size: number;
  durationMs: number;
  headers?: Record<string, string[]>;
}
