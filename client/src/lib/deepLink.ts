import type { Module } from '../store';

/**
 * What a link can say about the view: the module, the connection, and the
 * one thing selected in that module. A time range only means something
 * under a subject, a key only under a bucket.
 *
 * The link lives in the hash -- `#/subjects?conn=…&subject=…` -- so it
 * survives a BASE_PATH, a reverse proxy and the desktop shell alike, and
 * the server never sees it.
 */
export interface DeepLink {
  module?: Module;
  conn?: string;
  subject?: string;
  from?: number;
  to?: number;
  stream?: string;
  bucket?: string;
  key?: string;
  store?: string;
  service?: string;
  template?: string;
}

const MODULES: Module[] = ['subjects', 'state', 'jetstream', 'kv', 'objects', 'services', 'requests', 'events', 'monitor', 'cluster', 'alerts', 'audit'];

const STRING_KEYS = ['conn', 'subject', 'stream', 'bucket', 'key', 'store', 'service', 'template'] as const;

function isModule(s: string): s is Module {
  return (MODULES as string[]).includes(s);
}

/** Reads a hash such as `#/jetstream?conn=abc&stream=ORDERS`; anything it does not understand is left out. */
export function parseLink(hash: string): DeepLink {
  let s = hash.startsWith('#') ? hash.slice(1) : hash;
  if (s.startsWith('/')) s = s.slice(1);
  const q = s.indexOf('?');
  const path = q >= 0 ? s.slice(0, q) : s;
  const params = new URLSearchParams(q >= 0 ? s.slice(q + 1) : '');
  const link: DeepLink = {};
  if (isModule(path)) link.module = path;
  for (const k of STRING_KEYS) {
    const v = params.get(k);
    if (v) link[k] = v;
  }
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  // Half a window is no window: both ends or none, and in order.
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from) {
    link.from = Math.round(from);
    link.to = Math.round(to);
  }
  return link;
}

/** The hash for a link, `#/subjects?conn=…`; an empty link is an empty hash. */
export function formatLink(link: DeepLink): string {
  if (!link.module) return '';
  const params = new URLSearchParams();
  for (const k of STRING_KEYS) {
    const v = link[k];
    if (v) params.set(k, v);
  }
  if (link.from !== undefined && link.to !== undefined) {
    params.set('from', String(link.from));
    params.set('to', String(link.to));
  }
  const query = params.toString();
  return `#/${link.module}${query ? `?${query}` : ''}`;
}

/**
 * What the view is looking at, as a link. Only the selection of the current
 * module is carried: a link to the stream list has no business remembering
 * which subject was open before.
 */
export function linkFromState(s: {
  module: Module;
  activeConnId: string | null;
  selectedSubject: string | null;
  range: { from: number; to: number } | null;
  selectedStream: string | null;
  selectedKvBucket: string | null;
  selectedKvKey: string | null;
  selectedObjStore: string | null;
  selectedService: string | null;
  selectedTemplateId: string | null;
}): DeepLink {
  const link: DeepLink = { module: s.module };
  if (s.activeConnId) link.conn = s.activeConnId;
  switch (s.module) {
    case 'subjects':
      if (s.selectedSubject) {
        link.subject = s.selectedSubject;
        if (s.range) {
          link.from = s.range.from;
          link.to = s.range.to;
        }
      }
      break;
    case 'jetstream':
      if (s.selectedStream) link.stream = s.selectedStream;
      break;
    case 'kv':
      if (s.selectedKvBucket) {
        link.bucket = s.selectedKvBucket;
        if (s.selectedKvKey) link.key = s.selectedKvKey;
      }
      break;
    case 'objects':
      if (s.selectedObjStore) link.store = s.selectedObjStore;
      break;
    case 'services':
      if (s.selectedService) link.service = s.selectedService;
      break;
    case 'requests':
      if (s.selectedTemplateId) link.template = s.selectedTemplateId;
      break;
  }
  return link;
}

/** The part of a link that decides where it points, for telling a jump from a refinement. */
export function linkTarget(link: DeepLink): string {
  return [link.module, link.conn, link.subject, link.stream, link.bucket, link.key, link.store, link.service, link.template].map(v => v ?? '').join('\u0000');
}
