import type { SchemaField, SubjectSchema } from '../../lib/api.schema';
import { formatDateTime } from '../../lib/utils';

/**
 * The derived schema in forms other tools can consume: JSON Schema for
 * validators and code generators, and a TypeScript interface to paste into a
 * consumer. The backend reports one flat, dotted path per field
 * (`sensor.values[]`), so both start by rebuilding the tree from those paths.
 *
 * Everything here is derived from samples, not from a contract: a field that
 * never appeared is missing, and "required" only means "present in every
 * message that carried its parent". Both outputs say so in a header.
 */

/** One node of the rebuilt tree. */
interface Node {
  field?: SchemaField;
  /** object members, in the order the backend reported them */
  children: Map<string, Node>;
  /** the element type behind a `[]` step */
  items?: Node;
}

/** Splits a reported path into its steps: `a.b[].c` → a, b, [], c. */
export function pathSteps(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split('.')) {
    const m = /^(.*?)((?:\[\])*)$/.exec(part);
    if (!m) continue;
    if (m[1]) out.push(m[1]);
    for (let i = 0; i < m[2].length / 2; i++) out.push('[]');
  }
  return out;
}

function buildTree(fields: SchemaField[]): Node {
  const root: Node = { children: new Map() };
  for (const field of fields) {
    let node = root;
    for (const step of pathSteps(field.path)) {
      if (step === '[]') {
        node.items ??= { children: new Map() };
        node = node.items;
      } else {
        let child = node.children.get(step);
        if (!child) {
          child = { children: new Map() };
          node.children.set(step, child);
        }
        node = child;
      }
    }
    node.field = field;
  }
  return root;
}

/**
 * Types the field was seen with, most frequent first, without `null`. A
 * field seen with both integers and floats is a number field -- the backend
 * already folds the two, an older pinned schema may not have.
 */
function valueTypes(field: SchemaField | undefined): string[] {
  const types = (field?.types ?? []).map(t => t.type).filter(t => t !== 'null');
  return types.includes('number') ? types.filter(t => t !== 'integer') : types;
}

const nullable = (field: SchemaField | undefined) => (field?.types ?? []).some(t => t.type === 'null');

/**
 * An enumeration is only reported as a closed set when the field is nothing
 * but a string; with a number among the samples the set would exclude values
 * that legitimately occur.
 */
function closedEnum(field: SchemaField | undefined): string[] | null {
  if (!field?.enum?.length) return null;
  const types = valueTypes(field);
  return types.length === 1 && types[0] === 'string' ? field.enum : null;
}

/** A child is required when it appeared in every message its parent did. */
function isRequired(child: Node, parentPresence: number): boolean {
  const presence = child.field?.presence ?? 0;
  return presence >= parentPresence - 1e-9;
}

function percent(presence: number): string {
  const p = presence * 100;
  return `${p >= 99.95 || p === 0 ? Math.round(p) : p.toFixed(1).replace(/\.0$/, '')}%`;
}

/**
 * What is known about a field beyond its type, as one sentence. Empty when
 * there is nothing to say: a field that is always there and has no range
 * would only add "seen in 100%" to every line.
 */
function notes(field: SchemaField): string {
  const out: string[] = [];
  if (field.presence < 1) out.push(`seen in ${percent(field.presence)} of the sampled messages`);
  if (field.format === 'date-time') out.push('every sample was an RFC 3339 timestamp');
  if (field.min !== undefined && field.max !== undefined) {
    out.push(field.min === field.max ? `observed value ${field.min}` : `observed range ${field.min} … ${field.max}`);
  }
  // Values the enum was not emitted for still belong in the description.
  if (field.enum?.length && !closedEnum(field)) out.push(`observed strings: ${field.enum.join(', ')}`);
  return out.join('; ');
}

/** The example the backend carries, parsed back; undefined when truncated. */
function exampleValue(field: SchemaField): unknown {
  if (!field.example || field.example.endsWith('…')) return undefined;
  try {
    return JSON.parse(field.example);
  } catch {
    return undefined;
  }
}

const headline = (subject: string, schema: SubjectSchema) => {
  const samples = schema.kinds.json ?? 0;
  const span = schema.from && schema.to ? ` recorded between ${formatDateTime(schema.from)} and ${formatDateTime(schema.to)}` : '';
  return `Derived by NATS Explorer from ${samples} JSON message${samples === 1 ? '' : 's'} on ${subject}${span}.`;
};

const DISCLAIMER = 'Derived from samples, not from a contract: fields that never appeared are missing, and required means present in every sample.';

/* --- JSON Schema ------------------------------------------------------- */

const JSON_TYPES: Record<string, string> = {
  bool: 'boolean',
  integer: 'integer',
  number: 'number',
  string: 'string',
  object: 'object',
  array: 'array',
};

function jsonSchemaNode(node: Node, parentPresence: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const field = node.field;
  const types = valueTypes(field)
    .map(t => JSON_TYPES[t])
    .filter(Boolean);
  if (nullable(field)) types.push('null');
  if (types.length === 1) out.type = types[0];
  else if (types.length > 1) out.type = [...new Set(types)];
  // The root carries no field of its own; its shape says what it is.
  else if (node.children.size) out.type = 'object';
  else if (node.items) out.type = 'array';

  if (field) {
    const description = notes(field);
    if (description) out.description = description;
    const values = closedEnum(field);
    if (values) out.enum = values;
    // A format belongs to strings; on a field that also carried numbers it
    // would claim more than the samples showed.
    if (field.format && valueTypes(field).every(t => t === 'string')) out.format = field.format;
    const example = exampleValue(field);
    if (example !== undefined && !node.children.size && !node.items) out.examples = [example];
  }

  if (node.children.size) {
    const presence = field?.presence ?? parentPresence;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of node.children) {
      properties[key] = jsonSchemaNode(child, presence);
      if (isRequired(child, presence)) required.push(key);
    }
    out.properties = properties;
    if (required.length) out.required = required;
    // The samples cannot prove a field never occurs, so nothing is forbidden.
    out.additionalProperties = true;
  }
  if (node.items) out.items = jsonSchemaNode(node.items, field?.presence ?? parentPresence);
  return out;
}

/** The schema as a JSON Schema (draft 2020-12) document. */
export function toJsonSchema(subject: string, schema: SubjectSchema): string {
  const root = jsonSchemaNode(buildTree(schema.fields), 1);
  return `${JSON.stringify(
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `urn:nats:subject:${subject}`,
      title: subject,
      description: `${headline(subject, schema)} ${DISCLAIMER}`,
      ...root,
    },
    null,
    2,
  )}\n`;
}

/* --- TypeScript -------------------------------------------------------- */

/** `factory.line1.machine1.temp` → `FactoryLine1Machine1Temp`. */
export function typeName(subject: string): string {
  const name = subject
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('');
  if (!name) return 'Payload';
  return /^[0-9]/.test(name) ? `Subject${name}` : name;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const quoteKey = (key: string) => (IDENTIFIER.test(key) ? key : JSON.stringify(key));

const TS_TYPES: Record<string, string> = {
  bool: 'boolean',
  integer: 'number',
  number: 'number',
  string: 'string',
  object: 'Record<string, unknown>',
  array: 'unknown[]',
};

function tsType(node: Node, indent: string): string {
  const field = node.field;
  let base: string;
  if (node.children.size) {
    const lines: string[] = ['{'];
    const presence = field?.presence ?? 1;
    for (const [key, child] of node.children) {
      const note = child.field ? notes(child.field) : '';
      const doc = note ? `${indent}  /** ${note} */\n` : '';
      const optional = isRequired(child, presence) ? '' : '?';
      lines.push(`${doc}${indent}  ${quoteKey(key)}${optional}: ${tsType(child, `${indent}  `)};`);
    }
    lines.push(`${indent}}`);
    base = lines.join('\n');
  } else if (node.items) {
    const inner = tsType(node.items, indent);
    // A union inside an array needs its own parentheses.
    base = /[|&]/.test(inner) && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
  } else {
    const values = closedEnum(field);
    const types = values ? values.map(v => JSON.stringify(v)) : [...new Set(valueTypes(field).map(t => TS_TYPES[t] ?? 'unknown'))];
    base = types.length ? types.join(' | ') : 'unknown';
  }
  return nullable(field) ? `${base} | null` : base;
}

/** The schema as a TypeScript interface. */
export function toTypeScript(subject: string, schema: SubjectSchema): string {
  const root = buildTree(schema.fields);
  const header = `/**\n * ${headline(subject, schema)}\n *\n * ${DISCLAIMER}\n */\n`;
  const name = typeName(subject);
  // A payload that is an array at the top level cannot be an interface.
  if (!root.children.size && root.items) return `${header}export type ${name} = ${tsType(root, '')};\n`;
  const body = root.children.size ? tsType(root, '') : '{\n  [key: string]: unknown;\n}';
  return `${header}export interface ${name} ${body}\n`;
}
