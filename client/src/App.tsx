import { useEffect, useRef } from 'react';
import { MODULES, useStore } from './store';
import { wsClient } from './lib/ws';
import Header from './components/layout/Header';
import Rail from './components/layout/Rail';
import Explorer from './components/layout/Explorer';
import Detail from './components/layout/Detail';
import StatusBar from './components/layout/StatusBar';
import ResizeHandle from './components/layout/ResizeHandle';
import ConnectionDialog from './components/connection/ConnectionDialog';
import TokenDialog from './components/connection/TokenDialog';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { ConfirmHost } from './components/ui/Dialog';
import { Toaster } from './components/ui/Toast';
import { TooltipProvider } from './components/ui/misc';

export default function App() {
  const module = useStore(s => s.module);
  const hasExplorer = MODULES.find(m => m.id === module)?.hasExplorer ?? true;
  const counter = useRef(0);

  useEffect(() => {
    const { setConnections, applySubjectTree, addMessages, setSubscriptionStats, setWsOnline, setMessagesPerSecond } = useStore.getState();

    const unsubs = [
      wsClient.onStatus(status => setWsOnline(status === 'open')),
      wsClient.on('connections', e => setConnections(e.data)),
      wsClient.on('subject-tree', e => applySubjectTree(e.connId, e.full, e.data)),
      wsClient.on('message-batch', e => {
        addMessages(e.connId, e.data);
        counter.current += e.data.length;
        if (e.stats) setSubscriptionStats(e.connId, e.stats);
      }),
    ];
    api
      .authInfo()
      .then(info => {
        if (info.required && !useAuth.getState().token) useAuth.getState().setRequired(true);
      })
      .catch(() => undefined);
    // Tell the server what the user is looking at so the live feed spends its
    // budget there; repeated on every (re)connect.
    const sendFocus = () => wsClient.send({ type: 'focus', subject: useStore.getState().selectedSubject ?? '' });
    unsubs.push(
      wsClient.onStatus(status => status === 'open' && sendFocus()),
      useStore.subscribe((s, prev) => s.selectedSubject !== prev.selectedSubject && sendFocus()),
    );
    wsClient.connect();

    // Rate = messages over the last 3 seconds, so bursty publishers read steadily.
    const samples: number[] = [];
    const rateTimer = setInterval(() => {
      samples.push(counter.current);
      counter.current = 0;
      if (samples.length > 3) samples.shift();
      setMessagesPerSecond(Math.round(samples.reduce((a, b) => a + b, 0) / samples.length));
    }, 1000);

    return () => {
      unsubs.forEach(u => u());
      clearInterval(rateTimer);
      wsClient.disconnect();
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
      <TokenDialog />
      <ConfirmHost />
      <Toaster />
    </TooltipProvider>
  );
}
