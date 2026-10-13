import { useStore } from '../store';

/**
 * Global keyboard shortcuts: Ctrl-K (Cmd-K) opens the command palette,
 * "/" focuses the explorer's filter, "j"/"k" move through the subject
 * tree. Typing into a field is never intercepted, except for the palette,
 * which is wanted from anywhere.
 */
export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const s = useStore.getState();
      s.setPaletteOpen(!s.paletteOpen);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === '/') {
      const filter = document.querySelector<HTMLInputElement>('aside [data-filter]') ?? document.querySelector<HTMLInputElement>('[data-filter]');
      if (filter) {
        e.preventDefault();
        filter.focus();
        filter.select();
      }
      return;
    }
    if (e.key === 'j' || e.key === 'k') {
      const tree = document.querySelector<HTMLElement>('[role="tree"]');
      if (!tree) return;
      e.preventDefault();
      tree.focus();
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: e.key === 'j' ? 'ArrowDown' : 'ArrowUp', bubbles: true }));
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
