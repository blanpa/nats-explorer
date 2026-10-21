import { readSetting, writeSetting } from './utils';

/**
 * Once a day, whether a newer release exists. The desktop app has no store
 * to tell it, and a server left running for months has nobody looking.
 * One request to GitHub's release listing, nothing sent but the request,
 * and a switch in the settings for whoever would rather not.
 */

export const RELEASES_URL = 'https://github.com/blanpa/nats-explorer/releases';
const LATEST_API = 'https://api.github.com/repos/blanpa/nats-explorer/releases/latest';
const CHECK_KEY = 'ne.updateCheck';
const CACHE_KEY = 'ne.updateCheck.latest';
const EVERY_MS = 24 * 3600_000;

export interface Release {
  version: string;
  url: string;
}

/**
 * Where the desktop app's own update stands (GET /api/update). The backend
 * fetches the newest release itself, checks the signature over its
 * checksums and puts it in place; a server, a container or a .deb is not
 * supported and says why.
 */
export interface UpdateStatus {
  supported: boolean;
  reason?: string;
  kind?: 'appimage' | 'tarball' | 'windows' | 'macos';
  state: 'idle' | 'downloading' | 'ready' | 'failed';
  /** the release being put in place, or in place */
  version?: string;
  /** bytes of the download; total is missing while unknown */
  done?: number;
  total?: number;
  error?: string;
  /** the release file this installation is updated with; "<version>" stands for the version */
  asset?: string;
  /** the version the last update replaced, kept to go back to */
  previous?: string;
}

export function updateCheckEnabled(): boolean {
  return readSetting(CHECK_KEY, true);
}

export function setUpdateCheckEnabled(on: boolean): void {
  writeSetting(CHECK_KEY, on);
}

/** Compares two versions the way a release tag reads: 1.10.0 is newer than 1.9.2. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .map(p => Number.parseInt(p, 10))
      .map(n => (Number.isFinite(n) ? n : 0));
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

interface Cached {
  at: number;
  release: Release | null;
}

/**
 * The newest release when it is newer than what is running, else null. A
 * build without a version -- a development checkout -- is never behind.
 * The answer is cached for a day, so a tab reloaded all afternoon asks once.
 */
export async function checkForUpdate(current: string, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<Release | null> {
  if (!current || current === 'dev' || !updateCheckEnabled()) return null;
  let cached: Cached | null = null;
  try {
    cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
  } catch {
    cached = null;
  }
  let release = cached?.release ?? null;
  if (!cached || now - cached.at > EVERY_MS) {
    try {
      const res = await fetchFn(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return null;
      const body = (await res.json()) as { tag_name?: string; html_url?: string };
      release = body.tag_name ? { version: body.tag_name.replace(/^v/, ''), url: body.html_url ?? RELEASES_URL } : null;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, release } satisfies Cached));
      } catch {
        /* private mode */
      }
    } catch {
      return null;
    }
  }
  return release && isNewer(release.version, current) ? release : null;
}
