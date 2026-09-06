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
    // A token was required: hydrate once the user has entered it, then re-read the stores.
    const unsub = useAuth.subscribe((s, prev) => {
      if (s.token && s.token !== prev.token) {
        unsub();
        bootstrapStorage().then(rehydrate);
      }
    });
  }
}

async function rehydrate() {
  const [{ useSavedConnections }, { useSavedRequests }, { loadSavedConnections }, { loadSavedRequests }, { useStore }, { applyTheme, readTheme }, { readSetting }] = await Promise.all([
    import('./store/savedConnections'),
    import('./store/savedRequests'),
    import('./lib/savedConnections'),
    import('./lib/savedRequests'),
    import('./store'),
    import('./lib/theme'),
    import('./lib/utils'),
  ]);
  useSavedConnections.setState({ items: loadSavedConnections() });
  useSavedRequests.setState({ items: loadSavedRequests() });
  const theme = readTheme();
  applyTheme(theme);
  useStore.setState({ theme, hideSystemSubjects: readSetting('ne.hideSystemSubjects', true), explorerWidth: Math.max(220, Math.min(800, readSetting('ne.explorerWidth', 340))) });
}

start();
