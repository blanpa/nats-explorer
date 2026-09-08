/**
 * Global keyboard shortcuts: "/" focuses the explorer's filter, "j"/"k"
 * move through the subject tree. Typing into a field is never intercepted.
 */
export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
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
