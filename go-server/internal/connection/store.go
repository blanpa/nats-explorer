package connection

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"strings"
	"sync"
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
	SysAccount  bool   `json:"sysAccount"`
	SysError    string `json:"sysError,omitempty"`
	LastError   string `json:"lastError,omitempty"`
	Reconnects  uint64 `json:"reconnects"`
	ConnectedAt int64  `json:"connectedAt,omitempty"`
	// Bundle marks an imported support bundle: recorded messages, no server.
	Bundle bool `json:"bundle,omitempty"`
}

type Managed struct {
	ID          string
	Config      Config
	NC          *nats.Conn
	SysNC       *nats.Conn // system account connection, nil unless configured
	SysError    string
	Color       string
	ConnectedAt time.Time

	mu        sync.Mutex
	lastError string
}

func (m *Managed) setError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		m.lastError = err.Error()
	} else {
		m.lastError = ""
	}
}

func (m *Managed) status() Status {
	m.mu.Lock()
	lastErr := m.lastError
	m.mu.Unlock()

	nc := m.NC
	st := Status{
		ID:            m.ID,
		Name:          m.Config.Name,
		Color:         m.Color,
		Servers:       m.Config.Servers,
		Subscriptions: m.Config.Subscriptions,
		JSDomain:      m.Config.JSDomain,
		JSAPIPrefix:   m.Config.JSAPIPrefix,
		SysAccount:    m.SysNC != nil && m.SysNC.IsConnected(),
		SysError:      m.SysError,
		LastError:     lastErr,
	}
	if len(st.Subscriptions) == 0 {
		st.Subscriptions = []string{">"}
	}
	if nc == nil {
		return st
	}
	st.Connected = nc.IsConnected()
	st.Reconnecting = nc.IsReconnecting()
	st.Reconnects = nc.Stats().Reconnects
	if st.Connected {
		st.Server = nc.ConnectedUrl()
		st.ConnectedAt = m.ConnectedAt.UnixMilli()
	}
	return st
}

type Store struct {
	mu          sync.RWMutex
	connections map[string]*Managed
	// virtual holds imported bundles, which have no NATS connection
	virtual  map[string]Status
	colorIdx int
	onChange func()
}

func NewStore() *Store {
	return &Store{connections: make(map[string]*Managed), virtual: make(map[string]Status)}
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

func buildOptions(cfg Config, managed *Managed, notify func()) ([]nats.Option, error) {
	opts := []nats.Option{
		nats.Name("nats-explorer"),
		nats.Timeout(5 * time.Second),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2 * time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			managed.setError(err)
			notify()
		}),
		nats.ReconnectHandler(func(_ *nats.Conn) {
			managed.setError(nil)
			notify()
		}),
		nats.ClosedHandler(func(_ *nats.Conn) {
			notify()
		}),
		nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
			managed.setError(err)
		}),
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
func buildSysOptions(cfg Config) ([]nats.Option, error) {
	opts := []nats.Option{nats.Name("nats-explorer (system)"), nats.Timeout(5 * time.Second), nats.MaxReconnects(-1), nats.ReconnectWait(2 * time.Second)}
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

	managed := &Managed{ID: cfg.ID, Config: cfg}

	opts, err := buildOptions(cfg, managed, s.notify)
	if err != nil {
		return nil, err
	}

	nc, err := nats.Connect(strings.Join(cfg.Servers, ","), opts...)
	if err != nil {
		return nil, err
	}

	// The system-account connection is optional: a failure is reported, not fatal.
	if cfg.SysAuthMethod != "" && cfg.SysAuthMethod != "none" {
		sysOpts, err := buildSysOptions(cfg)
		if err != nil {
			managed.SysError = err.Error()
		} else if sysNC, err := nats.Connect(strings.Join(cfg.Servers, ","), sysOpts...); err != nil {
			managed.SysError = err.Error()
		} else {
			managed.SysNC = sysNC
		}
	}

	s.mu.Lock()
	managed.NC = nc
	managed.ConnectedAt = time.Now()
	managed.Color = colors[s.colorIdx%len(colors)]
	s.colorIdx++
	s.connections[cfg.ID] = managed
	s.mu.Unlock()

	s.notify()
	return managed, nil
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

	if managed.NC != nil {
		managed.NC.Close()
	}
	if managed.SysNC != nil {
		managed.SysNC.Close()
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
