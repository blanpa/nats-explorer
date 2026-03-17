package connection

import (
	"fmt"
	"strings"
	"sync"

	"github.com/nats-io/nats.go"
)

var colors = []string{"#4EC9B0", "#569cd6", "#ce9178", "#b5cea8", "#d4d4aa", "#c586c0", "#9cdcfe", "#dcdcaa"}

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

type Status struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Connected     bool     `json:"connected"`
	Server        string   `json:"server,omitempty"`
	Color         string   `json:"color"`
	Servers       []string `json:"servers,omitempty"`
	Subscriptions []string `json:"subscriptions,omitempty"`
}

type Managed struct {
	ID     string
	Config Config
	NC     *nats.Conn
	Color  string
}

type Store struct {
	mu          sync.RWMutex
	connections map[string]*Managed
	colorIdx    int
	onChange    func() // called when connections change
}

func NewStore() *Store {
	return &Store{
		connections: make(map[string]*Managed),
	}
}

func (s *Store) SetOnChange(fn func()) {
	s.onChange = fn
}

func (s *Store) Connect(cfg Config) (*Managed, error) {
	s.mu.Lock()
	// Disconnect existing with same ID
	if old, ok := s.connections[cfg.ID]; ok {
		s.mu.Unlock()
		s.Disconnect(cfg.ID)
		s.mu.Lock()
		_ = old // already cleaned up
	}

	opts := []nats.Option{
		nats.Name("nats-explorer"),
	}

	switch cfg.AuthMethod {
	case "token":
		opts = append(opts, nats.Token(cfg.Token))
	case "userpass":
		opts = append(opts, nats.UserInfo(cfg.User, cfg.Pass))
	case "nkey":
		if cfg.NKeySeed != "" {
			opt, err := nats.NkeyOptionFromSeed(cfg.NKeySeed)
			if err == nil {
				opts = append(opts, opt)
			}
		}
	case "jwt":
		if cfg.Creds != "" {
			// Write creds to temp and use
			opts = append(opts, nats.UserCredentials(cfg.Creds))
		}
	}

	if cfg.TLS {
		opts = append(opts, nats.Secure(nil))
	}

	serverURL := ""
	if len(cfg.Servers) > 0 {
		serverURL = strings.Join(cfg.Servers, ",")
	}

	nc, err := nats.Connect(serverURL, opts...)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}

	color := colors[s.colorIdx%len(colors)]
	s.colorIdx++

	managed := &Managed{
		ID:     cfg.ID,
		Config: cfg,
		NC:     nc,
		Color:  color,
	}
	s.connections[cfg.ID] = managed
	s.mu.Unlock()

	if s.onChange != nil {
		s.onChange()
	}
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

	managed.NC.Drain()

	if s.onChange != nil {
		s.onChange()
	}
	return nil
}

func (s *Store) DisconnectAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.connections))
	for id := range s.connections {
		ids = append(ids, id)
	}
	s.mu.Unlock()

	for _, id := range ids {
		s.Disconnect(id)
	}
}

func (s *Store) Get(connID string) (*Managed, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.connections[connID]
	return m, ok
}

func (s *Store) GetNC(connID string) (*nats.Conn, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.connections[connID]
	if !ok || m.NC == nil || !m.NC.IsConnected() {
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
	s.mu.RLock()
	defer s.mu.RUnlock()
	m, ok := s.connections[connID]
	if !ok {
		return Status{ID: connID, Connected: false}
	}
	server := ""
	if m.NC.IsConnected() {
		server = m.NC.ConnectedUrl()
	}
	subs := m.Config.Subscriptions
	if len(subs) == 0 {
		subs = []string{">"}
	}
	return Status{
		ID:            connID,
		Name:          m.Config.Name,
		Connected:     m.NC.IsConnected(),
		Server:        server,
		Color:         m.Color,
		Servers:       m.Config.Servers,
		Subscriptions: subs,
	}
}

func (s *Store) AllStatuses() []Status {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]Status, 0, len(s.connections))
	for id := range s.connections {
		result = append(result, s.GetStatusLocked(id))
	}
	return result
}

func (s *Store) GetStatusLocked(connID string) Status {
	m, ok := s.connections[connID]
	if !ok {
		return Status{ID: connID, Connected: false}
	}
	server := ""
	if m.NC.IsConnected() {
		server = m.NC.ConnectedUrl()
	}
	subs := m.Config.Subscriptions
	if len(subs) == 0 {
		subs = []string{">"}
	}
	return Status{
		ID:            connID,
		Name:          m.Config.Name,
		Connected:     m.NC.IsConnected(),
		Server:        server,
		Color:         m.Color,
		Servers:       m.Config.Servers,
		Subscriptions: subs,
	}
}
