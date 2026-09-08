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
}

/**
 * The structure the backend derived from a subject's recorded messages.
 * Without connId the histories of every connection are merged; from/to read
 * from the persistent history when it is enabled.
 */
export function getSchema(
  subject: string,
  opts: { connId?: string; limit?: number; from?: number; to?: number } = {},
): Promise<{ subject: string; schema: SubjectSchema }> {
  const q = new URLSearchParams({ subject });
  for (const [k, val] of Object.entries(opts)) if (val !== undefined && val !== '') q.set(k, String(val));
  return request<{ subject: string; schema: SubjectSchema }>(`/schema?${q.toString()}`);
}
