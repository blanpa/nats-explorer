/**
 * What the headers NATS sets actually mean.
 *
 * A header list is where a lot of JetStream behaviour is explained -- why a
 * publish was refused, why a message replaced the history, where a sourced
 * message came from -- and reading it takes knowing a dozen names by heart.
 * The names carry their meaning here instead.
 */

interface Known {
  /** one line, shown next to the header */
  what: string;
  /** how a value reads, where the value itself is a term */
  value?: (v: string) => string | undefined;
}

const KNOWN: Record<string, Known> = {
  'nats-msg-id': {
    what: 'Deduplication key. A second message with this id inside the stream’s duplicate window is discarded, and the publish is acknowledged as a duplicate.',
  },
  'nats-expected-stream': {
    what: 'The publish was accepted only if it reached this stream. It is how a publisher makes sure it is not writing into the wrong one.',
  },
  'nats-expected-last-sequence': {
    what: 'The publish was accepted only if this was the stream’s last sequence -- optimistic concurrency over the whole stream.',
  },
  'nats-expected-last-subject-sequence': {
    what: 'The publish was accepted only if this was the last sequence on this subject. This is how a per-subject compare-and-set is done.',
  },
  'nats-expected-last-msg-id': { what: 'The publish was accepted only if the last message carried this Nats-Msg-Id.' },
  'nats-rollup': {
    what: 'This message replaces what came before it.',
    value: v => (v === 'sub' ? 'Everything earlier on this subject was removed.' : v === 'all' ? 'The whole stream before it was removed.' : undefined),
  },
  'nats-stream': { what: 'The stream the message was read from.' },
  'nats-subject': { what: 'The subject it was stored under, which a direct get does not otherwise say.' },
  'nats-sequence': { what: 'Its sequence in the stream.' },
  'nats-timestamp': { what: 'When the stream stored it.' },
  'nats-last-sequence': { what: 'The previous sequence on the same subject, so a reader can tell whether it skipped one.' },
  'nats-stream-source': { what: 'The message came from another stream through a source or a mirror; the value names it and its sequence there.' },
  'nats-applied-limit': { what: 'A limit removed messages; the value says which one.' },
  'nats-marker-reason': { what: 'This is not a message but a marker the server left where messages were removed (MaxAge, Remove or Purge).' },
  'nats-service-error': { what: 'A micro service answered with an error instead of a result.' },
  'nats-service-error-code': { what: 'The error code that goes with Nats-Service-Error.' },
  'nats-request-info': { what: 'Who asked, added by a service framework.' },
  status: { what: 'A status reply rather than a message: 503 means nobody was listening, 408 that a request timed out.' },
  description: { what: 'The text that goes with Status.' },
};

/** What a header means, or nothing when it is the publisher's own. */
export function describeHeader(name: string, values: string[] = []): string | undefined {
  const known = KNOWN[name.toLowerCase()];
  if (!known) return undefined;
  const extra = known.value?.(values[0] ?? '');
  return extra ? `${known.what} ${extra}` : known.what;
}

/** Whether NATS set this header, as opposed to whoever published the message. */
export const isNatsHeader = (name: string): boolean => name.toLowerCase() in KNOWN;

/**
 * The deduplication key of a message, which is the only header a stream acts
 * on twice: the second message carrying it inside the duplicate window never
 * arrives at all.
 */
export function msgId(headers: Record<string, string[]> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'nats-msg-id' && v[0]) return v[0];
  return undefined;
}

/**
 * The message ids that occur more than once among the messages loaded here.
 *
 * A repeated id is worth pointing at: either the duplicate window had passed
 * -- and then the second message is in the stream on purpose -- or the two
 * are not the same message and the id is not unique, which is a bug in the
 * publisher waiting to eat a message.
 */
export function repeatedIds(messages: { headers?: Record<string, string[]> }[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const m of messages) {
    const id = msgId(m.headers);
    if (!id) continue;
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return twice;
}
