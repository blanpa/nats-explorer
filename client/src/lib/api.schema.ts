import { request } from './api';

/** How often a path carried a given JSON type. */
export interface SchemaTypeCount {
  type: string;
  count: number;
}

/** One path of a subject's payloads. */
export interface SchemaField {
  path: string;
  types: SchemaTypeCount[];
  /** share of the JSON messages that carried the path, 0..1 */
  presence: number;
  example: string;
  min?: number;
  max?: number;
  enum?: string[];
  /** the shape every sample of a string field had, e.g. "date-time" */
  format?: string;
}

/** A difference between the older and the newer half of the samples. */
export interface SchemaDrift {
  path: string;
  kind: 'type-changed' | 'field-gone' | 'field-new';
  before: string;
  after: string;
  /** timestamp of the first message of the newer half */
  since: number;
}

export interface SubjectSchema {
  samples: number;
  /** messages per payload kind: json, string, binary */
  kinds: Record<string, number>;
  fields: SchemaField[];
  drift: SchemaDrift[];
  from: number;
  to: number;
  /** the payloads have more fields than the backend reports; the list is a beginning */
  truncated?: boolean;
}

/**
 * The structure the backend derived from a subject's recorded messages.
 * Without connId the histories of every connection are merged; from/to read
 * from the persistent history when it is enabled.
 */
export function getSchema(subject: string, opts: { connId?: string; limit?: number; from?: number; to?: number } = {}): Promise<SchemaResponse> {
  const q = new URLSearchParams({ subject });
  for (const [k, val] of Object.entries(opts)) if (val !== undefined && val !== '') q.set(k, String(val));
  return request<SchemaResponse>(`/schema?${q.toString()}`);
}

export interface SchemaResponse {
  subject: string;
  schema: SubjectSchema;
  /** the pattern a schema is pinned under for this subject, if any */
  pinnedPattern?: string;
  /** how many of the sampled messages do not match it */
  invalid?: number;
}
