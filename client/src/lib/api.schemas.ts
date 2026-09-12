import { request } from './api';
import type { SchemaField, SubjectSchema } from './api.schema';

/**
 * Pinned schemas: the reference the derived schema lacks. Drift only compares
 * the samples to each other, so a subject that has always been wrong looks
 * consistent. Once a schema is pinned, every expression can judge a message
 * against it -- `!valid` in the payload filter, in a history query or in an
 * alert rule.
 */

/** One field of a pinned schema. */
export interface PinnedField {
  path: string;
  /** allowed JSON types; empty accepts anything */
  types?: string[];
  /** every message must carry the path */
  required?: boolean;
  /** closed set of allowed strings, only when it was pinned deliberately */
  enum?: string[];
}

export interface PinnedSchema {
  id: string;
  pattern: string;
  note?: string;
  pinnedAt: number;
  /** how many messages it was derived from */
  samples: number;
  fields: PinnedField[];
  /** also report fields the schema does not know */
  strict?: boolean;
}

/** What a derived schema turns into when it is pinned. */
export function pinnableFields(schema: SubjectSchema): PinnedField[] {
  return schema.fields.map((f: SchemaField) => ({
    path: f.path,
    types: [...new Set(f.types.map(t => t.type))].sort(),
    // What every sampled message carried is required; the rest is optional.
    required: f.presence >= 1,
  }));
}

export const schemasApi = {
  list: () => request<{ schemas: PinnedSchema[] }>('/schemas'),
  /** Pins a schema for a subject pattern, replacing one for the same pattern. */
  pin: (input: { pattern: string; fields: PinnedField[]; samples: number; note?: string; strict?: boolean }) =>
    request<PinnedSchema>('/schemas', { method: 'PUT', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } }),
  unpin: (pattern: string) => request<{ success: boolean }>(`/schemas?pattern=${encodeURIComponent(pattern)}`, { method: 'DELETE' }),
  /** Checks one payload without publishing it. */
  check: (subject: string, payload: string, kind = 'json') =>
    request<{ pinned: boolean; pattern?: string; violations: string[] }>('/schemas/check', {
      method: 'POST',
      body: JSON.stringify({ subject, payload, kind }),
      headers: { 'Content-Type': 'application/json' },
    }),
};
