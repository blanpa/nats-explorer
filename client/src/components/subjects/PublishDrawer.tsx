import { ChevronDown, ChevronUp, Send } from 'lucide-react';
import { useStore } from '../../store';
import PublishPanel from './PublishPanel';

/** Collapsible publish panel at the bottom of the subject views. */
export default function PublishDrawer() {
  const open = useStore(s => s.publishOpen);
  const setOpen = useStore(s => s.setPublishOpen);
  return (
    <div className="shrink-0 border-t border-line bg-panel">
      <button
        type="button"
        className="w-full h-8 flex items-center gap-2 px-3 text-xs font-semibold text-muted hover:text-fg"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Send size={12} />
        Publish
        <span className="ml-auto">{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</span>
      </button>
      {open && (
        <div className="border-t border-line max-h-[45vh] overflow-auto">
          <PublishPanel />
        </div>
      )}
    </div>
  );
}
