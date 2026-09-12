import type { BadgeTone } from '../ui/misc';
import type { SchemaDrift, SchemaField, SubjectSchema } from '../../lib/api.schema';

/**
 * A field is optional when it is missing from some messages; that is the one
 * thing about a derived schema people usually want to see at a glance.
 */
export function isOptional(f: SchemaField): boolean {
  return f.presence < 0.999;
}

/** Presence as a percentage, without a decimal point for the common cases. */
export function formatPresence(presence: number): string {
  const pct = presence * 100;
  if (pct >= 99.95) return '100%';
  if (pct <= 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** The value range or the enumeration of a field, whichever it has. */
export function formatRange(f: SchemaField): string {
  if (f.enum?.length) return f.enum.join(' | ');
  if (f.min === undefined || f.max === undefined) return '';
  if (f.min === f.max) return formatNumber(f.min);
  return `${formatNumber(f.min)} … ${formatNumber(f.max)}`;
}

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(4)));
}

/** Sentence for one drift entry, in the order people read it: what, then how. */
export function describeDrift(d: SchemaDrift): string {
  switch (d.kind) {
    case 'type-changed':
      return `type changed from ${d.before} to ${d.after}`;
    case 'field-gone':
      return `no longer sent (was ${d.before})`;
    case 'field-new':
      return `new field (${d.after})`;
    default:
      return d.kind;
  }
}

/** Colour of a type badge: numbers, strings and structures read differently. */
export function typeTone(type: string): BadgeTone {
  switch (type) {
    case 'integer':
    case 'number':
      return 'info';
    case 'string':
      return 'accent';
    case 'bool':
      return 'ok';
    case 'null':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** Drift entries by path, so a field row can show its own change. */
export function driftByPath(drift: SchemaDrift[]): Map<string, SchemaDrift> {
  const out = new Map<string, SchemaDrift>();
  for (const d of drift) if (!out.has(d.path)) out.set(d.path, d);
  return out;
}

/**
 * Payload kinds as one line, JSON first, so a subject that mixes JSON and
 * raw bytes says so instead of silently showing only its JSON fields.
 */
export function describeKinds(schema: SubjectSchema): string {
  const order = ['json', 'string', 'binary'];
  const parts = Object.entries(schema.kinds)
    .filter(([, n]) => n > 0)
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return parts.map(([kind, n]) => `${n} ${kind}`).join(' · ');
}

/** Fields that a vanished field leaves behind: drift for paths no field row carries. */
export function orphanDrift(schema: SubjectSchema): SchemaDrift[] {
  const known = new Set(schema.fields.map(f => f.path));
  return schema.drift.filter(d => !known.has(d.path));
}
