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
  /** the backing stream is S2-compressed */
  compression?: boolean;
  mirror?: KvSource;
  sources?: KvSource[];
  metadata?: Record<string, string>;
  placement?: { cluster?: string; tags?: string[] };
}

/** A bucket this one copies from, by bucket name; elsewhere by domain or API prefix. */
export interface KvSource {
  bucket: string;
  domain?: string;
  externalApi?: string;
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
  compression?: boolean;
  /** null takes it away on an update */
  mirror?: KvSource | null;
  sources?: KvSource[];
  metadata?: Record<string, string> | null;
}

/** What POST /api/kv/{bucket}/delete answers. */
export interface KvBulkDeleteResult {
  deleted: number;
  failed: Record<string, string>;
}
