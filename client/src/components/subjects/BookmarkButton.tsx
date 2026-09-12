import { useState } from 'react';
import { Star } from 'lucide-react';
import { type Bookmark, findBookmark, groupsOf, useBookmarks } from '../../lib/bookmarks';
import { cn } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input, Textarea } from '../ui/Input';

/**
 * Bookmarks the subject shown in the detail pane. A click adds or opens it;
 * the dialog carries the name, group and note.
 */
export default function BookmarkButton({ subject }: { subject: string }) {
  const items = useBookmarks(s => s.items);
  const toggle = useBookmarks(s => s.toggle);
  const save = useBookmarks(s => s.save);
  const remove = useBookmarks(s => s.remove);
  const existing = findBookmark(items, subject);
  const [draft, setDraft] = useState<Bookmark | null>(null);

  return (
    <>
      <IconButton
        label={existing ? `Edit the bookmark for ${subject}` : `Bookmark ${subject}`}
        onClick={() => (existing ? setDraft({ ...existing }) : toggle(subject))}
      >
        <Star size={14} className={cn(existing && 'fill-accent text-accent')} />
      </IconButton>
      {draft && (
        <Dialog
          open
          onOpenChange={o => !o && setDraft(null)}
          title="Bookmark"
          description={subject}
          width="sm"
          footer={
            <>
              <Button
                variant="danger"
                onClick={() => {
                  remove(draft.subject);
                  setDraft(null);
                }}
              >
                Remove
              </Button>
              <div className="flex-1" />
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  save({ ...draft, label: draft.label?.trim() || undefined, group: draft.group?.trim() || undefined, note: draft.note?.trim() || undefined });
                  setDraft(null);
                }}
              >
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Field label="Name" hint="Shown instead of the subject.">
              <Input autoFocus value={draft.label ?? ''} onChange={e => setDraft({ ...draft, label: e.target.value })} placeholder="Oven temperature" />
            </Field>
            <Field label="Group">
              <Input list="ne-bookmark-groups" value={draft.group ?? ''} onChange={e => setDraft({ ...draft, group: e.target.value })} placeholder="Line 3" />
            </Field>
            <datalist id="ne-bookmark-groups">
              {groupsOf(items).map(g => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <Field label="Note">
              <Textarea
                mono={false}
                rows={3}
                value={draft.note ?? ''}
                onChange={e => setDraft({ ...draft, note: e.target.value })}
                placeholder="What matters about this subject."
              />
            </Field>
          </div>
        </Dialog>
      )}
    </>
  );
}
