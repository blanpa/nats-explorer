import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { wsClient } from './lib/ws';
import Header from './components/layout/Header';
import ConnectionPanel from './components/connection/ConnectionPanel';
import Sidebar from './components/layout/Sidebar';
import MainContent from './components/layout/MainContent';
import StatusBar from './components/layout/StatusBar';

export default function App() {
  const { setConnections, setSubjectTree, addMessage } = useStore();
  const rateRef = useRef({ count: 0, lastReset: Date.now() });
  const [sidebarWidth, setSidebarWidth] = useState(340);
  const isDragging = useRef(false);

  useEffect(() => {
    wsClient.connect();

    const unsubs = [
      wsClient.on('connections', (conns) => {
        setConnections(conns);
      }),
      wsClient.on('subject-tree', (tree, connId) => {
        if (connId) setSubjectTree(connId, tree);
      }),
      wsClient.on('message-batch', (batch, connId) => {
        if (!connId || !Array.isArray(batch)) return;
        for (const msg of batch) {
          addMessage(connId, msg);
        }
        rateRef.current.count += batch.length;
      }),
      wsClient.on('message', (msg, connId) => {
        if (connId) addMessage(connId, msg);
        rateRef.current.count++;
      }),
    ];

    const rateInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - rateRef.current.lastReset) / 1000;
      const rate = elapsed > 0 ? rateRef.current.count / elapsed : 0;
      useStore.setState({ messagesPerSecond: Math.round(rate) });
      rateRef.current = { count: 0, lastReset: now };
    }, 1000);

    return () => {
      unsubs.forEach(u => u());
      clearInterval(rateInterval);
      wsClient.disconnect();
    };
  }, []);

  const handleMouseDown = () => { isDragging.current = true; };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      // Offset by connection panel width (~220px)
      const panelOffset = 220;
      setSidebarWidth(Math.max(180, Math.min(500, e.clientX - panelOffset)));
    };
    const handleMouseUp = () => { isDragging.current = false; };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <div className="app-root">
      <Header />
      <div className="app-body">
        <ConnectionPanel />
        <div className="sidebar" style={{ width: sidebarWidth }}>
          <Sidebar />
        </div>
        <div className="resize-handle" onMouseDown={handleMouseDown} />
        <div className="main-content">
          <MainContent />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
