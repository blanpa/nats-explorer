export interface NatsMessage {
  subject: string;
  payload: string;
  payloadType: 'string' | 'json' | 'binary';
  headers?: Record<string, string[]>;
  timestamp: number;
  reply?: string;
  size: number;
  sequence?: number;
}

export interface SubjectNode {
  segment: string;
  fullSubject: string;
  messageCount: number;
  lastMessage?: NatsMessage;
  children: SubjectNode[];
  rate: number;
}
