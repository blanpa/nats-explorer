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

export interface KvEntry {
  bucket: string;
  key: string;
  value: string;
  revision: number;
  created: string;
  operation: 'put' | 'delete' | 'purge';
  delta?: number;
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
