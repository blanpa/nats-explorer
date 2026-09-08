import React from 'react';
import ReactDOM from 'react-dom/client';
import { useAuth } from './lib/auth';
import { bootstrapStorage, setPersistErrorHandler } from './lib/storage';
import './index.css';

/**
 * The stores read localStorage when their modules are evaluated, so the app
 * (and everything it imports) is loaded only after the backend settings have
 * been copied into localStorage.
 */
async function start() {
  const hydrated = await bootstrapStorage().catch(() => true);
  const [{ default: App }, { toast }] = await Promise.all([import('./App'), import('./components/ui/Toast')]);
  setPersistErrorHandler(message => toast.error('Settings not saved', message));
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  if (!hydrated) {
    // A login was required: hydrate once the user is in, then re-read the stores.
    const unsub = useAuth.subscribe((s, prev) => {
      if (s.authenticated && !prev.authenticated) {
        unsub();
        bootstrapStorage().then(rehydrate);
      }
    });
  }
}

async function rehydrate() {
  const [
    { useSavedConnections },
    { useSavedRequests },
    { loadSavedConnections },
    { loadSavedRequests },
    { useStore },
    { applyTheme, readTheme },
    { readSetting },
    { useDecoders },
    { useBookmarks },
  ] = await Promise.all([
    import('./store/savedConnections'),
    import('./store/savedRequests'),
    import('./lib/savedConnections'),
    import('./lib/savedRequests'),
    import('./store'),
    import('./lib/theme'),
    import('./lib/utils'),
    import('./lib/decoders'),
    import('./lib/bookmarks'),
  ]);
  useSavedConnections.setState({ items: loadSavedConnections() });
  useSavedRequests.setState({ items: loadSavedRequests() });
  useDecoders.getState().reload();
  useBookmarks.getState().reload();
  const theme = readTheme();
  applyTheme(theme);
  useStore.setState({
    theme,
    hideSystemSubjects: readSetting('ne.hideSystemSubjects', true),
    explorerWidth: Math.max(220, Math.min(800, readSetting('ne.explorerWidth', 340))),
  });
}

start();
