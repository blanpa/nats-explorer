export interface ObjStoreInfo {
  bucket: string;
  description?: string;
  size: number;
  storage: string;
  sealed: boolean;
  replicas: number;
  chunks: number;
  backingStreamName: string;
}

export interface ObjInfo {
  name: string;
  description?: string;
  size: number;
  chunks: number;
  nuid: string;
  digest?: string;
  deleted: boolean;
  mtime: string;
  headers?: Record<string, string[]>;
}

export interface ObjStoreConfig {
  bucket: string;
  description?: string;
  maxBytes?: number;
  storage?: 'file' | 'memory';
  replicas?: number;
  ttl?: number;
}
