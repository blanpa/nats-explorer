/**
 * Where the backend lives. The server writes a `<base href>` into index.html,
 * so one build works at `/` and under any reverse-proxy subpath -- nothing is
 * baked in at build time, and the same bundle serves `https://host/` and
 * `https://host/nats/`.
 *
 * Everything that talks to the backend goes through `serverUrl`; a bare
 * `/api/...` would leave the subpath out and hit the proxy's root.
 *
 * The prefix is read on every call, not once into a constant: a module-level
 * value derived from the DOM is something a bundler may fold away, and one
 * that folded to "/" sent the websocket to the wrong path in a build where
 * the REST calls were still correct.
 */

/** The prefix the app is served under, always with a trailing slash. */
export function basePath(): string {
  try {
    return new URL('.', document.baseURI).pathname;
  } catch {
    return '/';
  }
}

/** Resolves a server path ("/api/app") against that prefix. */
export function serverUrl(path: string): string {
  return basePath().replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

/** The websocket endpoint, absolute because a worker has no document to resolve against. */
export function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${serverUrl('/ws')}`;
}
