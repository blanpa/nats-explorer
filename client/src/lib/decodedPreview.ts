import { create } from 'zustand';
import { decodeWith, findRule, type DecoderRule } from './decoders';
import { payloadBytes, truncate } from './utils';

/**
 * One line of a decoded binary payload, for the lists.
 *
 * A payload viewer decodes the message it is showing; a list shows hundreds
 * of rows and cannot await anything, so every protobuf, MessagePack and Avro
 * message read as the word "binary" -- the same word for a Sparkplug metric
 * set, a firmware frame and an empty buffer. The rows ask here instead: the
 * answer is whatever has already been decoded, and a miss starts a decode
 * whose result lands in this store and re-renders the list once.
 *
 * The cache is keyed by the payload itself, so the same message in the tree,
 * the history and the trace is decoded once. It is bounded, because a list
 * scrolled for an hour would otherwise hold every message that passed.
 */
const MAX_ENTRIES = 500;

/** Bigger than this is not a preview any more, and decoding it per row costs. */
const MAX_DECODE_BYTES = 64 * 1024;

interface PreviewState {
  /** payload -> one line, or null while the decode is in flight or failed */
  previews: Map<string, string | null>;
  note: (payload: string, line: string | null) => void;
}

const usePreviewStore = create<PreviewState>(set => ({
  previews: new Map(),
  note: (payload, line) =>
    set(s => {
      const next = new Map(s.previews);
      if (next.size >= MAX_ENTRIES) {
        // Oldest first: a Map keeps insertion order, and the rows that
        // matter are the ones on screen now.
        const oldest = next.keys().next().value;
        if (oldest !== undefined) next.delete(oldest);
      }
      next.set(payload, line);
      return { previews: next };
    }),
}));

/** A decoded value as one line: the fields, not the tree. */
export function previewLine(value: unknown, max = 90): string {
  try {
    return truncate(JSON.stringify(value) ?? String(value), max);
  } catch {
    return '';
  }
}

const inFlight = new Set<string>();

/**
 * The decoded line for a binary payload, or null when there is none yet.
 * Starts the decode on a miss; the store update brings the row back.
 */
export function decodedPreview(previews: Map<string, string | null>, rules: DecoderRule[], subject: string, payload: string, max = 90): string | null {
  const known = previews.get(payload);
  if (known !== undefined) return known;
  const rule = findRule(rules, subject);
  if (!rule || payload.length === 0 || inFlight.has(payload)) return null;
  const bytes = payloadBytes(payload, 'binary');
  if (bytes.length > MAX_DECODE_BYTES) return null;
  inFlight.add(payload);
  decodeWith(rule, bytes)
    .then(res => usePreviewStore.getState().note(payload, res.ok ? previewLine(res.value, max) : null))
    .finally(() => inFlight.delete(payload));
  return null;
}

/** What a list needs to call `decodedPreview`: the cache and the rules. */
export const useDecodedPreviews = () => usePreviewStore(s => s.previews);

/** The same cache outside React, for tests and for a one-off read. */
export const previewCache = () => usePreviewStore.getState().previews;
