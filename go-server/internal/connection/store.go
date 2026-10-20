package connection

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
)

var colors = []string{"#2ec4a5", "#5aa9ff", "#e8a06b", "#a7d68b", "#c99cff", "#f5b53f", "#7fd3e6", "#f28fb1"}

type Config struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Servers    []string `json:"servers"`
	AuthMethod string   `json:"authMethod"`
	Token      string   `json:"token,omitempty"`
	User       string   `json:"user,omitempty"`
	Pass       string   `json:"pass,omitempty"`
	NKeySeed   string   `json:"nkeySeed,omitempty"`
	Creds      string   `json:"creds,omitempty"`
	TLS        bool     `json:"tls,omitempty"`
	// PEM material for TLS: a CA to trust, and an optional client certificate
	// + key for mutual TLS. TLSInsecure skips server verification.
	TLSCA       string `json:"tlsCa,omitempty"`
	TLSCert     string `json:"tlsCert,omitempty"`
	TLSKey      string `json:"tlsKey,omitempty"`
	TLSInsecure bool   `json:"tlsInsecure,omitempty"`
	// TLSFirst does the TLS handshake before the server's INFO, for
	// servers configured with handshake_first.
	TLSFirst       bool     `json:"tlsFirst,omitempty"`
	Subscriptions  []string `json:"subscriptions,omitempty"`
	MonitoringPort int      `json:"monitoringPort,omitempty"`
	MonitoringURL  string   `json:"monitoringUrl,omitempty"`
	// JSDomain routes JetStream API calls to a specific JetStream domain
	// (e.g. a leaf node's domain reachable through this server). JSAPIPrefix
	// is the raw alternative for imported JetStream APIs; it wins when set.
	JSDomain    string `json:"jsDomain,omitempty"`
	JSAPIPrefix string `json:"jsApiPrefix,omitempty"`
	// SSH, when set, routes the connection through a bastion host.
	SSH *SSHConfig `json:"ssh,omitempty"`
	// Retry keeps trying a server that cannot be reached at the first
	// attempt instead of failing the connect: for connections opened at
	// start, when the explorer may come up before NATS does.
	Retry bool `json:"-"`
	// Optional credentials for the NATS system account ($SYS). They open a
	// second connection used only for cluster-wide monitoring requests.
	SysAuthMethod string `json:"sysAuthMethod,omitempty"`
	SysToken      string `json:"sysToken,omitempty"`
	SysUser       string `json:"sysUser,omitempty"`
	SysPass       string `json:"sysPass,omitempty"`
	SysNKeySeed   string `json:"sysNkeySeed,omitempty"`
	SysCreds      string `json:"sysCreds,omitempty"`
}

// Status is what the browser sees for every managed connection.
type Status struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Connected     bool     `json:"connected"`
	Reconnecting  bool     `json:"reconnecting"`
	Server        string   `json:"server,omitempty"`
	Color         string   `json:"color"`
	Servers       []string `json:"servers,omitempty"`
	Subscriptions []string `json:"subscriptions,omitempty"`
	JSDomain      string   `json:"jsDomain,omitempty"`
	JSAPIPrefix   string   `json:"jsApiPrefix,omitempty"`
	// SysAccount is true when a system-account connection is open; SysError
	// explains why it is not although credentials were given.
	SysAccount bool   `json:"sysAccount"`
	SysError   string `json:"sysError,omitempty"`
	LastError  string `json:"lastError,omitempty"`
	Reconnects uint64 `json:"reconnects"`
	// LastDrop is the last time the connection was lost, with the server's
	// reason when it could be asked; SlowConsumerDrops counts the times the
	// server closed it as a slow consumer.
	LastDrop          *Drop `json:"lastDrop,omitempty"`
	SlowConsumerDrops int   `json:"slowConsumerDrops,omitempty"`
	// The subscriptions have a connection of their own (see Managed.LiveNC):
	// whether it is reconnecting and how often it did, or why there is
	// none and they share the API's.
	LiveReconnecting bool   `json:"liveReconnecting,omitempty"`
	LiveReconnects   uint64 `json:"liveReconnects,omitempty"`
	LiveError        string `json:"liveError,omitempty"`
	// LivePauseMs is how long the live connection still waits before it
	// tries again after it dropped LiveFlaps times in a row soon after
	// connecting (live.go). A duration, not a time: the browser's clock
	// need not agree with the server's.
	LivePauseMs int64 `json:"livePauseMs,omitempty"`
	LiveFlaps   int   `json:"liveFlaps,omitempty"`
	// Links are the NATS connections open for it right now: the API's,
	// the subscriptions' and the system account's, as far as they exist.
	Links       []LinkStatus `json:"links,omitempty"`
	ConnectedAt int64        `json:"connectedAt,omitempty"`
	// Bundle marks an imported support bundle: recorded messages, no server.
	Bundle bool `json:"bundle,omitempty"`
	// SSH says the connection goes through a bastion; SSHHostKey is the
	// bastion's key as presented when none was pinned, for pinning it.
	SSH        bool   `json:"ssh,omitempty"`
	SSHHostKey string `json:"sshHostKey,omitempty"`
}

type Managed struct {
	ID     string
	Config Config
	NC     *nats.Conn
	// LiveNC carries the subscriptions, so a server that drops it as a slow
	// consumer leaves the API -- streams, KV, requests -- standing. Nil when
	// the server would not take a second connection, LiveError says why, and
	// NC carries them then; nil too while nothing is subscribed. Guarded by
	// liveMu, see live.go.
	LiveNC      *nats.Conn
	LiveError   string
	liveMu      sync.Mutex
	liveOpts    []nats.Option
	onLiveMoved func()
	SysNC       *nats.Conn // system account connection, nil unless configured
	SysError    string
	Color       string
	ConnectedAt time.Time
	// tunnel is the SSH session the connection goes through, if any.
	tunnel *sshDialer

	// policyMu guards the live connection's reconnect policy (live.go);
	// apiUp is whether the API's connection is connected, for that policy,
	// which runs under nats.go's lock and cannot ask the connection
	policyMu sync.Mutex
	apiUp    atomic.Bool

	mu        sync.Mutex
	lastError string
	// lastErrorLink is the link lastError came from
	lastErrorLink string
	// what is needed to ask the server why a connection was lost (drop.go)
	api, live, system link
	// log is the store's log for this connection ID (log.go); stop ends
	// the sampling of its rates
	log               *eventLog
	stop              chan struct{}
	lastDrop          *Drop
	slowConsumerDrops int
}

// setError sets the error the UI shows for a connection, or clears it when
// err is nil -- an error of the API link is cleared by the API link coming
// back, one of the live link by either: a live connection that works again
// must not leave its old error standing while the API never dropped.
func (m *Managed) setError(link string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case err != nil:
		m.lastError, m.lastErrorLink = err.Error(), link
	case link == "api" || m.lastErrorLink == link:
		m.lastError, m.lastErrorLink = "", ""
	}
}

// LinkStatus is one of the NATS connections behind a connection.
type LinkStatus struct {
	// Name is api, live or system.
	Name         string `json:"name"`
	Connected    bool   `json:"connected"`
	Reconnecting bool   `json:"reconnecting"`
	Server       string `json:"server,omitempty"`
	CID          uint64 `json:"cid,omitempty"`
	// Since is when the current connection was made, in ms.
	Since      int64  `json:"since,omitempty"`
	Reconnects uint64 `json:"reconnects"`
}

// links describes the NATS connections that exist for m, in the order
// they are made.
func (m *Managed) links() []LinkStatus {
	var out []LinkStatus
	live, _ := m.liveConn()
	for _, c := range []struct {
		l  *link
		nc *nats.Conn
	}{{&m.api, m.NC}, {&m.system, m.SysNC}, {&m.live, live}} {
		if c.nc == nil || c.nc.IsClosed() {
			continue
		}
		ls := LinkStatus{Name: c.l.name, Connected: c.nc.IsConnected(), Reconnecting: c.nc.IsReconnecting(), Reconnects: c.nc.Stats().Reconnects}
		m.mu.Lock()
		if ls.Connected {
			ls.Server, ls.CID = c.l.url, c.l.cid
			if !c.l.since.IsZero() {
				ls.Since = c.l.since.UnixMilli()
			}
		}
		m.mu.Unlock()
		out = append(out, ls)
	}
	return out
}

func (m *Managed) status() Status {
	m.mu.Lock()
	lastErr := m.lastError
	var drop *Drop
	if m.lastDrop != nil {
		d := *m.lastDrop
		drop = &d
	}
	slowDrops := m.slowConsumerDrops
	connectedAt := m.ConnectedAt
	m.mu.Unlock()
	m.policyMu.Lock()
	flaps, pausedUntil := m.live.flaps, m.live.pausedUntil
	m.policyMu.Unlock()
	live, liveErr := m.liveConn()

	nc := m.NC
	st := Status{
		ID:                m.ID,
		Name:              m.Config.Name,
		Color:             m.Color,
		Servers:           m.Config.Servers,
		Subscriptions:     m.Config.Subscriptions,
		JSDomain:          m.Config.JSDomain,
		JSAPIPrefix:       m.Config.JSAPIPrefix,
		SysAccount:        m.SysNC != nil && m.SysNC.IsConnected(),
		SysError:          m.SysError,
		LastError:         lastErr,
		LastDrop:          drop,
		SlowConsumerDrops: slowDrops,
		LiveError:         liveErr,
		Links:             m.links(),
	}
	if left := time.Until(pausedUntil); left > 0 {
		st.LivePauseMs, st.LiveFlaps = max(left.Milliseconds(), 1), flaps
	}
	if m.tunnel != nil {
		st.SSH = true
		st.SSHHostKey = m.tunnel.HostKeySeen()
	}
	if live != nil {
		st.LiveReconnecting = live.IsReconnecting()
		st.LiveReconnects = live.Stats().Reconnects
	}
	if nc == nil {
		return st
	}
	st.Connected = nc.IsConnected()
	st.Reconnecting = nc.IsReconnecting()
	st.Reconnects = nc.Stats().Reconnects
	if st.Connected {
		st.Server = nc.ConnectedUrl()
		// Connected a moment before the connect is announced, with Retry:
		// no time rather than the year one.
		if !connectedAt.IsZero() {
			st.ConnectedAt = connectedAt.UnixMilli()
		}
	}
	return st
}

type Store struct {
	mu          sync.RWMutex
	connections map[string]*Managed
	// virtual holds imported bundles, which have no NATS connection
	virtual map[string]Status
	// logs outlive the connections they are about; see eventLog
	logs     map[string]*eventLog
	colorIdx int
	onChange func()
	// onLiveMoved moves a connection's subscriptions to its API connection
	onLiveMoved func(connID string)
}

func NewStore() *Store {
	return &Store{connections: make(map[string]*Managed), virtual: make(map[string]Status), logs: make(map[string]*eventLog)}
}

// SetOnChange registers a callback fired whenever a connection is added,
// removed, or changes its NATS-level state (disconnect, reconnect, close).
func (s *Store) SetOnChange(fn func()) {
	s.onChange = fn
}

func (s *Store) notify() {
	if s.onChange != nil {
		go s.onChange()
	}
}

// commonOptions are what every NATS connection of the explorer gets.
//
// A connection that died without a word -- a VPN or a firewall dropping it
// silently -- is noticed by the pings: one every 20 s, and two unanswered
// make it stale, so the UI says "reconnecting" after about a minute, not
// after the four to six minutes of nats.go's defaults.
func commonOptions(cfg Config, name string) []nats.Option {
	opts := []nats.Option{
		nats.Name(name),
		nats.Timeout(5 * time.Second),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(reconnectWait),
		nats.PingInterval(20 * time.Second),
		nats.MaxPingsOutstanding(2),
	}
	if cfg.Retry {
		opts = append(opts, nats.RetryOnFailedConnect(true))
	}
	return opts
}

// buildOptions makes the options of the API connection or of the
// subscriptions' one (l.name "live"). A lost live connection is reported as
// a drop, not as the connection's error: the API is still there.
func buildOptions(cfg Config, managed *Managed, l *link, notify func()) ([]nats.Option, error) {
	name := "nats-explorer"
	if l.name == "live" {
		name = "nats-explorer (live)"
	}
	opts := append(commonOptions(cfg, name), managed.handlers(l, notify)...)
	if l.name == "live" {
		opts = append(opts, nats.ReconnectToServer(managed.nextLiveServer))
	}

	authOpts, err := authOptions(cfg.AuthMethod, cfg.Token, cfg.User, cfg.Pass, cfg.NKeySeed, cfg.Creds)
	if err != nil {
		return nil, err
	}
	opts = append(opts, authOpts...)

	if cfg.TLS || cfg.TLSCA != "" || cfg.TLSCert != "" || cfg.TLSKey != "" {
		tc, err := tlsConfigFor(cfg)
		if err != nil {
			return nil, err
		}
		opts = append(opts, nats.Secure(tc))
		// A server with handshake_first expects TLS before it sends its
		// INFO; without this the connection hangs until the timeout.
		if cfg.TLSFirst {
			opts = append(opts, nats.TLSHandshakeFirst())
		}
	}
	return opts, nil
}

// tlsConfigFor turns the PEM strings of a config into a tls.Config.
func tlsConfigFor(cfg Config) (*tls.Config, error) {
	tc := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: cfg.TLSInsecure} //nolint:gosec // opt-in by the user
	if ca := strings.TrimSpace(cfg.TLSCA); ca != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(ca)) {
			return nil, fmt.Errorf("CA certificate: no PEM certificate found")
		}
		tc.RootCAs = pool
	}
	cert, key := strings.TrimSpace(cfg.TLSCert), strings.TrimSpace(cfg.TLSKey)
	if cert != "" || key != "" {
		if cert == "" || key == "" {
			return nil, fmt.Errorf("client certificate and key must both be provided")
		}
		pair, err := tls.X509KeyPair([]byte(cert), []byte(key))
		if err != nil {
			return nil, fmt.Errorf("client certificate: %w", err)
		}
		tc.Certificates = []tls.Certificate{pair}
	}
	return tc, nil
}

// authOptions turns one set of credentials into nats options.
func authOptions(method, token, user, pass, nkeySeed, creds string) ([]nats.Option, error) {
	switch method {
	case "token":
		return []nats.Option{nats.Token(token)}, nil
	case "userpass":
		return []nats.Option{nats.UserInfo(user, pass)}, nil
	case "nkey":
		if nkeySeed == "" {
			return nil, fmt.Errorf("nkey seed required")
		}
		opt, err := nats.NkeyOptionFromSeed(nkeySeed)
		if err != nil {
			return nil, fmt.Errorf("invalid nkey seed: %w", err)
		}
		return []nats.Option{opt}, nil
	case "jwt":
		if strings.TrimSpace(creds) == "" {
			return nil, fmt.Errorf("credentials required")
		}
		// The browser sends the .creds file *content*, not a path.
		return []nats.Option{nats.UserCredentialBytes([]byte(creds))}, nil
	}
	return nil, nil
}

// buildSysOptions dials the same servers with the system-account credentials.
func buildSysOptions(cfg Config, managed *Managed, notify func()) ([]nats.Option, error) {
	opts := append(commonOptions(cfg, "nats-explorer (system)"), managed.handlers(&managed.system, notify)...)
	authOpts, err := authOptions(cfg.SysAuthMethod, cfg.SysToken, cfg.SysUser, cfg.SysPass, cfg.SysNKeySeed, cfg.SysCreds)
	if err != nil {
		return nil, err
	}
	opts = append(opts, authOpts...)
	if cfg.TLS || cfg.TLSCA != "" || cfg.TLSCert != "" || cfg.TLSKey != "" {
		tc, err := tlsConfigFor(cfg)
		if err != nil {
			return nil, err
		}
		opts = append(opts, nats.Secure(tc))
		// A server with handshake_first expects TLS before it sends its
		// INFO; without this the connection hangs until the timeout.
		if cfg.TLSFirst {
			opts = append(opts, nats.TLSHandshakeFirst())
		}
	}
	return opts, nil
}

func normalizeServers(servers []string) []string {
	out := make([]string, 0, len(servers))
	for _, s := range servers {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if !strings.Contains(s, "://") {
			s = "nats://" + s
		}
		out = append(out, s)
	}
	return out
}

// Connect dials NATS and registers the connection. Dialing happens outside the
// store lock so a slow server does not block every other API call.
func (s *Store) Connect(cfg Config) (*Managed, error) {
	cfg.Servers = normalizeServers(cfg.Servers)
	if len(cfg.Servers) == 0 {
		return nil, fmt.Errorf("at least one server URL is required")
	}

	// Replace an existing connection with the same ID.
	if _, ok := s.Get(cfg.ID); ok {
		s.Disconnect(cfg.ID)
	}

	managed := &Managed{ID: cfg.ID, Config: cfg, log: s.logFor(cfg.ID)}
	managed.api.name, managed.live.name, managed.system.name = "api", "live", "system"

	// A connect that fails is logged too: it is the first line of most
	// "it does not connect" reports.
	failed := func(err error) error {
		managed.event(&managed.api, "failed", strings.Join(redactURLs(cfg.Servers), ", ")+": "+err.Error())
		return err
	}
	opts, err := buildOptions(cfg, managed, &managed.api, s.notify)
	if err != nil {
		return nil, failed(err)
	}
	liveOpts, _ := buildOptions(cfg, managed, &managed.live, s.notify)
	// Inboxes of this connection's own: every reply the explorer waits for,
	// the JetStream API's included, arrives under one prefix, so a `>`
	// subscription can tell its own traffic from the network's (see
	// subscription.Manager). Still under _INBOX, which permissions allow.
	// Both connections share it, so the live one knows the API's replies;
	// each still answers under a subject of its own below it.
	inbox := nats.CustomInboxPrefix(nats.NewInbox())
	opts = append(opts, inbox)
	liveOpts = append(liveOpts, inbox)
	// Through a bastion: one SSH session, every dial of the NATS client
	// through it, the system-account connection included.
	if cfg.SSH != nil && strings.TrimSpace(cfg.SSH.Host) != "" {
		tunnel, err := newSSHDialer(*cfg.SSH)
		if err != nil {
			return nil, failed(err)
		}
		managed.tunnel = tunnel
		opts = append(opts, nats.SetCustomDialer(tunnel))
		liveOpts = append(liveOpts, nats.SetCustomDialer(tunnel))
	}

	nc, err := nats.Connect(strings.Join(cfg.Servers, ","), opts...)
	if err != nil {
		if managed.tunnel != nil {
			managed.tunnel.Close()
		}
		return nil, failed(err)
	}
	// With Retry the server may not be there yet: nats.go keeps trying and
	// the connect is announced when it gets through.
	if nc.IsConnected() {
		managed.announce(&managed.api, nc)
	}
	managed.liveOpts = liveOpts
	managed.onLiveMoved = func() {
		if s.onLiveMoved != nil {
			s.onLiveMoved(cfg.ID)
		}
		s.notify()
	}

	// The system account's connection and the subscriptions' need only the
	// API's to be up; they are dialled side by side.
	var wg sync.WaitGroup
	if cfg.SysAuthMethod != "" && cfg.SysAuthMethod != "none" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			managed.dialSystem(cfg, s.notify)
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		managed.openLive()
	}()
	wg.Wait()

	managed.stop = make(chan struct{})
	go managed.sampleRates(managed.stop)
	s.mu.Lock()
	managed.NC = nc
	managed.Color = colors[s.colorIdx%len(colors)]
	s.colorIdx++
	s.connections[cfg.ID] = managed
	s.mu.Unlock()

	s.notify()
	return managed, nil
}

// dialSystem opens the system account's connection. It is optional: a
// failure is reported, not fatal.
func (m *Managed) dialSystem(cfg Config, notify func()) {
	opts, err := buildSysOptions(cfg, m, notify)
	if err == nil && m.tunnel != nil {
		opts = append(opts, nats.SetCustomDialer(m.tunnel))
	}
	var nc *nats.Conn
	if err == nil {
		nc, err = nats.Connect(strings.Join(cfg.Servers, ","), opts...)
	}
	if err != nil {
		m.SysError = err.Error()
		m.event(&m.system, "failed", m.SysError)
		return
	}
	m.SysNC = nc
	if nc.IsConnected() {
		m.announce(&m.system, nc)
	}
}

func (s *Store) Disconnect(connID string) error {
	s.mu.Lock()
	managed, ok := s.connections[connID]
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("connection not found")
	}
	delete(s.connections, connID)
	s.mu.Unlock()

	if managed.stop != nil {
		close(managed.stop)
	}
	const why = "closed in the explorer"
	managed.closeLive(why)
	managed.mu.Lock()
	managed.api.closeNote, managed.system.closeNote = why, why
	managed.mu.Unlock()
	if managed.NC != nil {
		managed.NC.Close()
	}
	if managed.SysNC != nil {
		managed.SysNC.Close()
	}
	if managed.tunnel != nil {
		managed.tunnel.Close()
	}
	s.notify()
	return nil
}

// SetSubscriptions replaces the subject patterns of a live connection. The
// caller restarts the subscription manager; this only records the change
// and tells the browsers.
func (s *Store) SetSubscriptions(connID string, subs []string) (Config, error) {
	s.mu.Lock()
	managed, ok := s.connections[connID]
	if !ok {
		s.mu.Unlock()
		return Config{}, fmt.Errorf("connection not found")
	}
	managed.Config.Subscriptions = subs
	cfg := managed.Config
	s.mu.Unlock()
	s.notify()
	return cfg, nil
}

func (s *Store) DisconnectAll() {
	for _, m := range s.All() {
		s.Disconnect(m.ID)
	}
}

func (s *Store) Get(connID string) (*Managed, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.connections[connID]
	return m, ok
}

func (s *Store) GetNC(connID string) (*nats.Conn, error) {
	if s.IsVirtual(connID) {
		return nil, errVirtual(connID)
	}
	m, ok := s.Get(connID)
	if !ok || m.NC == nil {
		return nil, fmt.Errorf("connection not found")
	}
	if !m.NC.IsConnected() {
		return nil, fmt.Errorf("not connected")
	}
	return m.NC, nil
}

// GetLiveNC returns the connection the subscriptions run on: their own,
// also while it reconnects (nats.go subscribes again once it is back), or
// the API's when the server refused one.
//
// A connection without one yet -- its subscriptions were all removed and
// it was released -- gets it opened here.
func (s *Store) GetLiveNC(connID string) (*nats.Conn, error) {
	if m, ok := s.Get(connID); ok {
		if nc := m.openLive(); nc != nil {
			return nc, nil
		}
	}
	return s.GetNC(connID)
}

func (s *Store) All() []*Managed {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*Managed, 0, len(s.connections))
	for _, m := range s.connections {
		result = append(result, m)
	}
	return result
}

func (s *Store) GetStatus(connID string) Status {
	m, ok := s.Get(connID)
	if !ok {
		s.mu.RLock()
		st, isVirtual := s.virtual[connID]
		s.mu.RUnlock()
		if isVirtual {
			return st
		}
		return Status{ID: connID}
	}
	return m.status()
}

func (s *Store) AllStatuses() []Status {
	all := s.All()
	result := make([]Status, 0, len(all))
	for _, m := range all {
		result = append(result, m.status())
	}
	// Imported bundles sit next to the live connections; every module reads
	// their recorded history the same way.
	return append(result, s.virtualStatuses()...)
}
