import { useStore } from '../store';
import { useSavedConnections } from '../store/savedConnections';
import { type DeepLink, formatLink, linkFromState, linkTarget, parseLink } from './deepLink';
import { windowRange } from './timeRange';
import { toast } from '../components/ui/Toast';

/**
 * Keeps the address bar and the view in step, both ways.
 *
 * The hash says what is on screen -- module, connection, the subject or
 * stream or key open in it, the time range -- so the address can be copied
 * and sent, and whoever opens it sees the same thing. The other way round,
 * a hash on load or a back button is applied to the store.
 *
 * A link may name a connection that is not open yet, or not even reported
 * yet: the connection list arrives over the websocket. The link is held
 * until the list is in, and if the connection is only saved it is opened,
 * because opening it is what the link asks for.
 */

let pending: DeepLink | null = null;
let applying = false;

/** Applies what the link says to the store; the connection must be resolved by then. */
function applySelection(link: DeepLink) {
  const s = useStore.getState();
  applying = true;
  try {
    if (link.module) s.setModule(link.module);
    switch (link.module) {
      case 'subjects':
        if (link.subject) {
          s.revealSubject(link.subject);
          if (link.from !== undefined && link.to !== undefined) s.setRange(windowRange(link.from, link.to));
        } else if (s.selectedSubject) {
          s.setSelectedSubject(null);
        }
        break;
      case 'jetstream':
        s.setSelectedStream(link.stream ?? null);
        break;
      case 'kv':
        s.setSelectedKvBucket(link.bucket ?? null);
        if (link.bucket) s.setSelectedKvKey(link.key ?? null);
        break;
      case 'objects':
        s.setSelectedObjStore(link.store ?? null);
        break;
      case 'services':
        s.setSelectedService(link.service ?? null);
        break;
      case 'requests':
        s.setSelectedTemplateId(link.template ?? null);
        break;
    }
  } finally {
    applying = false;
  }
}

/**
 * Tries to apply the pending link. Returns true once it is done with it,
 * which includes giving up on a connection nobody knows.
 */
async function resolvePending(): Promise<void> {
  const link = pending;
  if (!link) return;
  const s = useStore.getState();
  if (!link.conn) {
    pending = null;
    applySelection(link);
    return;
  }
  if (!s.connectionsLoaded) return;
  pending = null;
  const known = s.connections.find(c => c.id === link.conn);
  if (known) {
    s.setActiveConnId(known.id);
    applySelection(link);
    return;
  }
  const saved = useSavedConnections.getState().items.find(c => c.id === link.conn);
  if (saved) {
    // The module first, so the connecting happens in front of the right view.
    if (link.module) s.setModule(link.module);
    const ok = await useSavedConnections.getState().connect(saved.id);
    if (ok) applySelection(link);
    return;
  }
  toast.warning('Link to an unknown connection', 'This explorer has no connection with that id; the rest of the link is applied without it.');
  applySelection(link);
}

/** The hash for what is on screen now. */
function currentHash(): string {
  return formatLink(linkFromState(useStore.getState()));
}

function writeHash(hash: string, jump: boolean) {
  if (hash === location.hash) return;
  const url = `${location.pathname}${location.search}${hash}`;
  // A new place gets a history entry, so the back button walks back through
  // the subjects opened; a zoom or a connection switch refines the one it is on.
  if (jump) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

/** Start syncing; returns the cleanup. */
export function installUrlSync(): () => void {
  pending = parseLink(location.hash);
  if (!pending.module && !pending.conn) pending = null;
  let lastTarget = linkTarget(linkFromState(useStore.getState()));

  const unsub = useStore.subscribe(state => {
    // While a link waits for its connection, the address keeps saying what
    // it said: a reload must not lose the link to a half-applied view.
    if (pending || applying) return;
    const link = linkFromState(state);
    const target = linkTarget(link);
    writeHash(formatLink(link), target !== lastTarget);
    lastTarget = target;
  });

  const unsubPending = useStore.subscribe(state => {
    if (pending && state.connectionsLoaded) void resolvePending();
  });

  const onPop = () => {
    const link = parseLink(location.hash);
    if (!link.module && !link.conn) return;
    lastTarget = linkTarget(link);
    pending = link;
    void resolvePending();
  };
  window.addEventListener('popstate', onPop);

  void resolvePending();

  return () => {
    unsub();
    unsubPending();
    window.removeEventListener('popstate', onPop);
    pending = null;
  };
}

/** The address of what is on screen, for the clipboard. */
export function currentLink(): string {
  return `${location.origin}${location.pathname}${location.search}${currentHash()}`;
}
