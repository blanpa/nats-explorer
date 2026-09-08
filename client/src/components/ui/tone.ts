import type { previewPayload } from '../../lib/utils';

export type Tone = ReturnType<typeof previewPayload>['tone'];

/** Text colour per payload preview tone, shared by every message list. */
export const toneClass: Record<Tone, string> = {
  str: 'text-syn-str',
  num: 'text-syn-num',
  bool: 'text-syn-bool',
  null: 'text-syn-null',
  obj: 'text-muted',
  bin: 'text-muted italic',
};
