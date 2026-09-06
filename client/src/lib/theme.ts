import { readSetting, writeSetting } from './utils';

export type Theme = 'dark' | 'light';

const KEY = 'ne.theme';

export function readTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  const stored = readSetting<string>(KEY, '');
  if (stored === 'light' || stored === 'dark') return stored;
  try {
    // value written by older versions without JSON quoting
    const raw = localStorage.getItem(KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* ignore */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  writeSetting(KEY, theme);
}
