import type { PayloadType } from './messages.js';

export interface KvBucketInfo {
  bucket: string;
  description?: string;
  values: number;
  history: number;
  ttl: number;
  maxValueSize: number;
  maxBytes: number;
  storage: string;
  replicas: number;
  bytes: number;
  backingStreamName: string;
}

export type KvOperation = 'put' | 'delete' | 'purge';

export interface KvEntry {
  bucket: string;
  key: string;
  value: string;
  payloadType: PayloadType;
  size: number;
  revision: number;
  created: string;
  operation: KvOperation;
  history?: KvEntry[];
}

export interface KvBucketConfig {
  bucket: string;
  description?: string;
  history?: number;
  ttl?: number;
  maxValueSize?: number;
  maxBytes?: number;
  storage?: 'file' | 'memory';
  replicas?: number;
}
