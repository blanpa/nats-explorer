import { useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNarrow } from './lib/narrow';
import { MODULES, useStore } from './store';
import { startFeed } from './lib/feed';
import { installShortcuts } from './lib/shortcuts';
import { installUrlSync } from './lib/urlSync';
import Header from './components/layout/Header';
import Rail from './components/layout/Rail';
import Explorer from './components/layout/Explorer';
import Detail from './components/layout/Detail';
import StatusBar from './components/layout/StatusBar';
import ExplorerResizeHandle from './components/layout/ResizeHandle';
import ConnectionDialog from './components/connection/ConnectionDialog';
import SettingsDialog from './components/layout/SettingsDialog';
import CommandPalette from './components/layout/CommandPalette';
import LoginDialog from './components/connection/LoginDialog';
import { useAuth } from './lib/auth';
import { ConfirmHost } from './components/ui/Dialog';
import { Toaster } from './components/ui/Toast';
import { TooltipProvider } from './components/ui/misc';

export default function App() {
  const module = useStore(s => s.module);
  const hasExplorer = MODULES.find(m => m.id === module)?.hasExplorer ?? true;
  const narrow = useNarrow();
  const narrowPane = useStore(s => s.narrowPane);
  const setNarrowPane = useStore(s => s.setNarrowPane);
  // A choice in the list is a wish to see it: on a narrow window that means
  // the detail takes the screen. A new module starts on its list.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.module !== prev.module) s.setNarrowPane('list');
        else if (
          s.selectedSubject !== prev.selectedSubject ||
          s.selectedStream !== prev.selectedStream ||
          s.selectedKvBucket !== prev.selectedKvBucket ||
          s.selectedObjStore !== prev.selectedObjStore ||
          s.selectedService !== prev.selectedService ||
          s.selectedTemplateId !== prev.selectedTemplateId
        )
          s.setNarrowPane('detail');
      }),
    [],
  );
  const showList = hasExplorer && (!narrow || narrowPane === 'list');
  const showDetail = !hasExplorer || !narrow || narrowPane === 'detail';

  useEffect(() => {
    useAuth.getState().refresh();
    const stopFeed = startFeed();
    const stopShortcuts = installShortcuts();
    const stopUrlSync = installUrlSync();
    return () => {
      stopFeed();
      stopShortcuts();
      stopUrlSync();
    };
  }, []);

  return (
    <TooltipProvider>
      <div className="h-full flex flex-col bg-canvas text-fg">
        <Header />
        <div className="flex-1 flex min-h-0">
          <Rail />
          {showList && (
            <>
              <Explorer fill={narrow} />
              {!narrow && <ExplorerResizeHandle />}
            </>
          )}
          {showDetail && (
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {narrow && hasExplorer && (
                <button
                  type="button"
                  className="h-8 shrink-0 flex items-center gap-1 px-2 text-xs text-muted border-b border-line bg-panel hover:text-fg"
                  onClick={() => setNarrowPane('list')}
                >
                  <ChevronLeft size={14} /> Back to the list
                </button>
              )}
              <Detail />
            </div>
          )}
        </div>
        <StatusBar />
      </div>
      <ConnectionDialog />
      <SettingsDialog />
      <CommandPalette />
      <LoginDialog />
      <ConfirmHost />
      <Toaster />
    </TooltipProvider>
  );
}
