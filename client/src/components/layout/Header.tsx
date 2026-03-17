import { useStore } from '../../store';

export default function Header() {
  const { connections, activeConnId, theme, toggleTheme } = useStore();
  const activeConn = connections.find(c => c.id === activeConnId);
  const connectedCount = connections.filter(c => c.connected).length;

  return (
    <div className="header-bar">
      <div className="header-brand">
        <span className="header-logo">N</span>
        <span className="header-title">NATS Explorer</span>
      </div>

      <div className="header-spacer" />

      {activeConn && (
        <div className="header-active-conn">
          <span className="header-active-dot" style={{ background: activeConn.color }} />
          <span className="header-active-name">{activeConn.name}</span>
          <span className="header-active-server">{activeConn.server}</span>
          {activeConn.subscriptions && activeConn.subscriptions[0] !== '>' && (
            <span className="header-active-subs">
              [{activeConn.subscriptions.join(', ')}]
            </span>
          )}
        </div>
      )}

      {connectedCount > 1 && (
        <span className="header-conn-count">{connectedCount} connections</span>
      )}

      <div className="header-spacer" />

      <button onClick={toggleTheme} className="header-btn-icon" title="Toggle theme">
        {theme === 'dark' ? '\u2600' : '\uD83C\uDF19'}
      </button>
    </div>
  );
}
