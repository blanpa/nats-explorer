package connection

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

var colors = []string{"#2ec4a5", "#5aa9ff", "#e8a06b", "#a7d68b", "#c99cff", "#f5b53f", "#7fd3e6", "#f28fb1"}

type Config struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Servers        []string `json:"servers"`
	AuthMethod     string   `json:"authMethod"`
	Token          string   `json:"token,omitempty"`
	User           string   `json:"user,omitempty"`
	Pass           string   `json:"pass,omitempty"`
	NKeySeed       string   `json:"nkeySeed,omitempty"`
	Creds          string   `json:"creds,omitempty"`
	TLS            bool     `json:"tls,omitempty"`
	Subscriptions  []string `json:"subscriptions,omitempty"`
	MonitoringPort int      `json:"monitoringPort,omitempty"`
	MonitoringURL  string   `json:"monitoringUrl,omitempty"`
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
	LastError     string   `json:"lastError,omitempty"`
	Reconnects    uint64   `json:"reconnects"`
	ConnectedAt   int64    `json:"connectedAt,omitempty"`
}

type Managed struct {
	ID          string
	Config      Config
	NC          *nats.Conn
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
	colorIdx    int
	onChange    func()
}

func NewStore() *Store {
	return &Store{connections: make(map[string]*Managed)}
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

	switch cfg.AuthMethod {
	case "token":
		opts = append(opts, nats.Token(cfg.Token))
	case "userpass":
		opts = append(opts, nats.UserInfo(cfg.User, cfg.Pass))
	case "nkey":
		if cfg.NKeySeed == "" {
			return nil, fmt.Errorf("nkey seed required")
		}
		opt, err := nats.NkeyOptionFromSeed(cfg.NKeySeed)
		if err != nil {
			return nil, fmt.Errorf("invalid nkey seed: %w", err)
		}
		opts = append(opts, opt)
	case "jwt":
		if strings.TrimSpace(cfg.Creds) == "" {
			return nil, fmt.Errorf("credentials required")
		}
		// The browser sends the .creds file *content*, not a path.
		opts = append(opts, nats.UserCredentialBytes([]byte(cfg.Creds)))
	}

	if cfg.TLS {
		opts = append(opts, nats.Secure())
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
	s.notify()
	return nil
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
	return result
}
