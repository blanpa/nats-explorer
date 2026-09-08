import { useEffect } from 'react';
import { MODULES, useStore } from './store';
import { startFeed } from './lib/feed';
import { installShortcuts } from './lib/shortcuts';
import Header from './components/layout/Header';
import Rail from './components/layout/Rail';
import Explorer from './components/layout/Explorer';
import Detail from './components/layout/Detail';
import StatusBar from './components/layout/StatusBar';
import ResizeHandle from './components/layout/ResizeHandle';
import ConnectionDialog from './components/connection/ConnectionDialog';
import LoginDialog from './components/connection/LoginDialog';
import { useAuth } from './lib/auth';
import { ConfirmHost } from './components/ui/Dialog';
import { Toaster } from './components/ui/Toast';
import { TooltipProvider } from './components/ui/misc';

export default function App() {
  const module = useStore(s => s.module);
  const hasExplorer = MODULES.find(m => m.id === module)?.hasExplorer ?? true;

  useEffect(() => {
    useAuth.getState().refresh();
    const stopFeed = startFeed();
    const stopShortcuts = installShortcuts();
    return () => {
      stopFeed();
      stopShortcuts();
    };
  }, []);

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-canvas text-fg">
        <Header />
        <div className="flex-1 flex min-h-0">
          <Rail />
          {hasExplorer && (
            <>
              <Explorer />
              <ResizeHandle />
            </>
          )}
          <Detail />
        </div>
        <StatusBar />
      </div>
      <ConnectionDialog />
      <LoginDialog />
      <ConfirmHost />
      <Toaster />
    </TooltipProvider>
  );
}
