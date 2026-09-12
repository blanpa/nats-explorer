import type { NatsMessage } from 'shared';
import { tryParseJson } from './utils';

/**
 * What the server says went wrong, in words.
 *
 * JetStream and the system account publish an event for everything that
 * matters -- a consumer that gave up after five attempts, a message
 * terminated, a stream that lost quorum, an API call that was refused, a
 * client that could not authenticate. The payloads are JSON with a `type`
 * like `io.nats.jetstream.advisory.v1.max_deliver`, and reading them raw in
 * the subject tree is reading a log without a log viewer: the answer to "my
 * message never arrived" is usually one of these lines.
 *
 * Anything unknown is still shown. A new advisory type is a thing that
 * happened, and hiding it because this file has not heard of it would be the
 * one failure mode a log viewer must not have.
 */

export type EventSeverity = 'error' | 'warn' | 'info';

export interface ServerEvent {
  at: number;
  subject: string;
  /** short name of the kind, e.g. "max deliveries" */
  kind: string;
  severity: EventSeverity;
  /** the one line a reader wants */
  title: string;
  /** where it happened, for a jump */
  stream?: string;
  consumer?: string;
  message: NatsMessage;
}

interface Advisory {
  type?: string;
  stream?: string;
  consumer?: string;
  stream_seq?: number;
  deliveries?: number;
  delay?: number;
  reason?: string;
  action?: string;
  subject?: string;
  response?: string;
  error?: { description?: string; code?: number };
  leader?: string;
  client?: { name?: string; lang?: string; host?: string; user?: string; acc?: string };
  server?: { name?: string; host?: string };
  account?: string;
  reply?: string;
}

const seq = (a: Advisory) => (a.stream_seq !== undefined ? ` sequence ${a.stream_seq}` : '');
const where = (a: Advisory) => [a.consumer, a.stream].filter(Boolean).join(' on ');
const server = (a: Advisory) => a.server?.name ?? a.server?.host ?? 'the server';
const client = (a: Advisory) => a.client?.name || a.client?.user || a.client?.host || 'a client';

/** The line for one advisory type. Unknown types fall through to the suffix. */
const KINDS: Record<string, (a: Advisory) => { kind: string; severity: EventSeverity; title: string }> = {
  max_deliver: a => ({
    kind: 'max deliveries',
    severity: 'error',
    title: `${where(a) || 'a consumer'} gave up on${seq(a)} after ${a.deliveries ?? '?'} deliveries`,
  }),
  terminated: a => ({
    kind: 'terminated',
    severity: 'error',
    title: `${where(a) || 'a consumer'} terminated${seq(a)}${a.reason ? `: ${a.reason}` : ''}`,
  }),
  nak: a => ({
    kind: 'nak',
    severity: 'warn',
    title: `${where(a) || 'a consumer'} asked for${seq(a) || ' a message'} again${a.delay ? ` in ${Math.round(a.delay / 1e9)}s` : ''}`,
  }),
  api_audit: a => {
    const failed = typeof a.response === 'string' && a.response.includes('"error"');
    return {
      kind: 'API call',
      severity: failed ? 'error' : 'info',
      title: `${failed ? 'A JetStream API call failed' : 'JetStream API call'}${a.subject ? `: ${a.subject}` : ''}`,
    };
  },
  stream_action: a => ({
    kind: `stream ${a.action ?? 'action'}`,
    severity: a.action === 'delete' ? 'warn' : 'info',
    title: `Stream ${a.stream ?? '?'} was ${a.action ?? 'changed'}d`.replace('dd', 'd'),
  }),
  consumer_action: a => ({
    kind: `consumer ${a.action ?? 'action'}`,
    severity: a.action === 'delete' ? 'warn' : 'info',
    title: `Consumer ${where(a) || '?'} was ${a.action ?? 'changed'}d`.replace('dd', 'd'),
  }),
  stream_leader_elected: a => ({ kind: 'leader elected', severity: 'warn', title: `${a.stream ?? 'A stream'} elected ${a.leader ?? 'a new leader'}` }),
  consumer_leader_elected: a => ({ kind: 'leader elected', severity: 'warn', title: `${where(a) || 'A consumer'} elected ${a.leader ?? 'a new leader'}` }),
  stream_quorum_lost: a => ({ kind: 'quorum lost', severity: 'error', title: `${a.stream ?? 'A stream'} lost quorum and cannot be written to` }),
  consumer_quorum_lost: a => ({ kind: 'quorum lost', severity: 'error', title: `${where(a) || 'A consumer'} lost quorum` }),
  server_out_of_space: a => ({ kind: 'out of space', severity: 'error', title: `${server(a)} ran out of space${a.stream ? ` writing ${a.stream}` : ''}` }),
  consumer_pause: a => ({ kind: 'paused', severity: 'warn', title: `${where(a) || 'A consumer'} was paused` }),
  snapshot_create: a => ({ kind: 'snapshot', severity: 'info', title: `Snapshot of ${a.stream ?? 'a stream'} started` }),
  snapshot_complete: a => ({ kind: 'snapshot', severity: 'info', title: `Snapshot of ${a.stream ?? 'a stream'} finished` }),
  restore_create: a => ({ kind: 'restore', severity: 'warn', title: `Restore of ${a.stream ?? 'a stream'} started` }),
  restore_complete: a => ({ kind: 'restore', severity: 'warn', title: `Restore of ${a.stream ?? 'a stream'} finished` }),
  client_connect: a => ({ kind: 'client connect', severity: 'info', title: `${client(a)} connected to ${server(a)}` }),
  client_disconnect: a => ({
    kind: 'client disconnect',
    severity: a.reason && !/client closed|connection closed/i.test(a.reason) ? 'warn' : 'info',
    title: `${client(a)} left ${server(a)}${a.reason ? `: ${a.reason}` : ''}`,
  }),
};

/**
 * What is published on a timer rather than because something happened.
 * `$JS.EVENT.METRIC.>` carries the ack and latency metrics of every message
 * a consumer handles; a list of those is a firehose, not a log.
 */
const NOISE_TYPES = new Set(['statsz', 'server_stats', 'consumer_ack', 'service_latency', 'account_connections']);
const NOISY_SUBJECT = /\.(STATSZ|SERVER\.[^.]+\.STATSZ|HEARTBEAT|PING)(\.|$)/i;

const humanise = (suffix: string) => suffix.replace(/_/g, ' ');

const severityOf = (suffix: string): EventSeverity => {
  if (/lost|denied|err|error|fail|out_of_space|max_deliver|terminated|expired/i.test(suffix)) return 'error';
  if (/nak|pause|restore|leader|disconnect|stall|warn/i.test(suffix)) return 'warn';
  return 'info';
};

/**
 * One recorded message as an event, or null when it is not one: the stats
 * the servers publish every few seconds are not events, and neither is a
 * payload that is not JSON.
 */
export function describeEvent(m: NatsMessage): ServerEvent | null {
  if (!m.subject.startsWith('$JS.EVENT.') && !m.subject.startsWith('$SYS.')) return null;
  if (NOISY_SUBJECT.test(m.subject)) return null;
  if (m.subject.startsWith('$JS.EVENT.METRIC.')) return null;
  const parsed = m.payloadType === 'json' ? (tryParseJson(m.payload) as Advisory | undefined) : undefined;
  const advisory: Advisory = parsed && typeof parsed === 'object' ? parsed : {};
  const type = typeof advisory.type === 'string' ? advisory.type : '';
  const suffix = type.split('.').pop() ?? '';
  if (NOISE_TYPES.has(suffix)) return null;
  const known = KINDS[suffix];
  const authErr = /AUTH\.ERR$/i.test(m.subject);
  const base = known
    ? known(advisory)
    : authErr
      ? {
          kind: 'auth error',
          severity: 'error' as EventSeverity,
          title: `${client(advisory)} could not authenticate${advisory.reason ? `: ${advisory.reason}` : ''}`,
        }
      : {
          kind: suffix ? humanise(suffix) : 'event',
          severity: severityOf(`${suffix} ${m.subject}`),
          // An unknown event still says where it came from; the payload is
          // one click away and nothing is swallowed.
          title: suffix ? `${humanise(suffix)}${where(advisory) ? ` — ${where(advisory)}` : ''}` : m.subject,
        };
  return {
    at: m.timestamp,
    subject: m.subject,
    stream: advisory.stream,
    consumer: advisory.consumer,
    message: m,
    ...base,
  };
}

/** The events among these messages, newest first. */
export function eventsOf(messages: NatsMessage[]): ServerEvent[] {
  const out: ServerEvent[] = [];
  for (const m of messages) {
    const e = describeEvent(m);
    if (e) out.push(e);
  }
  return out.sort((a, b) => b.at - a.at);
}

export const SEVERITY_ORDER: EventSeverity[] = ['error', 'warn', 'info'];

/** How many of each severity, for the counters above the list. */
export function countBySeverity(events: ServerEvent[]): Record<EventSeverity, number> {
  const out: Record<EventSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const e of events) out[e.severity]++;
  return out;
}
