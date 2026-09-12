import type { NatsMessage } from 'shared';
import { api } from './api';

/**
 * Pages a whole time range in, for an export.
 *
 * The view loads a range one page at a time as it is scrolled, which is
 * right for reading and wrong for exporting: picking "30 d" and getting the
 * first 2 000 messages is not what the range says. An export asks for what
 * was selected, so it keeps paging until the server says there is no more.
 */

/**
 * The ceiling an export stops at. It is far above what a view holds, because
 * nothing here is rendered -- but a range can cover millions of messages and
 * a browser tab cannot hold them, so the export stops and says it did rather
 * than dying with a file half written.
 */
export const EXPORT_MAX_MESSAGES = 200_000;

/** How many a single request asks for; the server caps one range query at 10 000. */
const PAGE = 5000;

export interface WholeRange {
  messages: NatsMessage[];
  /** true when the ceiling was reached and older messages were left behind */
  truncated: boolean;
}

/**
 * Every connection pages on its own (timestamp, sequence) cursor, because
 * sequences count per connection; the pages are merged as they arrive.
 */
export async function fetchWholeRange(
  subject: string,
  range: { from: number; to: number },
  seed: { messages: NatsMessage[]; more?: boolean },
  onProgress?: (loaded: number) => void,
): Promise<WholeRange> {
  const messages = [...seed.messages];
  let more = seed.more ?? false;
  // A page that brings nothing new would loop forever; the cursor not moving
  // is the signal to stop.
  let guard = 0;
  while (more && messages.length < EXPORT_MAX_MESSAGES && guard < 1000) {
    guard++;
    const cursors = new Map<string, NatsMessage>();
    for (const m of messages) if (m.connId) cursors.set(m.connId, m);
    if (cursors.size === 0) break;
    const pages = await Promise.all(
      [...cursors].map(([connId, m]) =>
        api.getHistoryRange(subject, {
          from: range.from,
          to: range.to,
          branch: true,
          limit: PAGE,
          connId,
          beforeTs: m.timestamp,
          beforeSeq: m.sequence,
        }),
      ),
    );
    const older = pages.flatMap(p => p.messages);
    if (older.length === 0) break;
    messages.push(...older);
    more = pages.some(p => p.more);
    onProgress?.(messages.length);
  }
  return { messages, truncated: more && messages.length >= EXPORT_MAX_MESSAGES };
}
