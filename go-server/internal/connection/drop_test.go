package connection

import (
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// A server that closes the explorer as a slow consumer says so: the drop
// carries its reason, asked on the monitoring port or over the system
// account after the reconnect, instead of the "EOF" the client saw.
func TestDropExplainedAsSlowConsumer(t *testing.T) {
	t.Run("monitoring", func(t *testing.T) {
		ns := startSlowServer(t, &natsserver.Options{HTTPHost: "127.0.0.1", HTTPPort: -1})
		expectSlowConsumerDrop(t, ns, Config{MonitoringURL: fmt.Sprintf("http://127.0.0.1:%d", ns.MonitorAddr().Port)})
	})
	t.Run("system account", func(t *testing.T) {
		sysAcc, appAcc := natsserver.NewAccount("$SYS"), natsserver.NewAccount("APP")
		ns := startSlowServer(t, &natsserver.Options{
			Accounts: []*natsserver.Account{sysAcc, appAcc}, SystemAccount: "$SYS",
			Users: []*natsserver.User{
				{Username: "sys", Password: "pw", Account: sysAcc},
				{Username: "app", Password: "app", Account: appAcc},
			},
			NoAuthUser: "app",
		})
		// No monitoring port to fall back on.
		expectSlowConsumerDrop(t, ns, Config{
			MonitoringURL: "http://127.0.0.1:1", SysAuthMethod: "userpass", SysUser: "sys", SysPass: "pw",
		})
	})
}

// startSlowServer runs a server that holds little for a client before it
// calls it a slow consumer.
func startSlowServer(t *testing.T, opts *natsserver.Options) *natsserver.Server {
	t.Helper()
	opts.Host, opts.Port, opts.NoLog, opts.NoSigs = "127.0.0.1", -1, true, true
	opts.MaxPayload, opts.MaxPending = 16*1024, 32*1024
	ns, err := natsserver.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats-server did not start")
	}
	t.Cleanup(ns.Shutdown)
	return ns
}

func expectSlowConsumerDrop(t *testing.T, ns *natsserver.Server, cfg Config) {
	t.Helper()
	// The explorer reaches the server over a link that can be stalled.
	px := startProxy(t, ns.Addr().String())

	s := NewStore()
	cfg.ID, cfg.Name, cfg.Servers = "c", "c", []string{"nats://" + px.addr}
	m, err := s.Connect(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Disconnect("c") })
	if m.LiveNC == nil {
		t.Fatalf("no live connection: %s", m.LiveError)
	}
	if _, err := m.LiveNC.Subscribe("load.>", func(*nats.Msg) {}); err != nil {
		t.Fatal(err)
	}
	m.LiveNC.Flush()

	pub, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	// More than the socket buffers and the server's pending budget take
	// while the link is stalled.
	px.stalled.Store(true)
	for i := 0; i < 2000; i++ {
		pub.Publish("load.big", make([]byte, 16*1024-512))
	}
	pub.Flush()
	px.stalled.Store(false)

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st := s.GetStatus("c")
		if st.LastDrop != nil && st.LastDrop.SlowConsumer {
			if st.SlowConsumerDrops != 1 || st.LastDrop.Reason != "Slow Consumer (Pending Bytes)" || !st.LastDrop.Live {
				t.Fatalf("drop = %+v, count %d", st.LastDrop, st.SlowConsumerDrops)
			}
			// The API's connection carried none of it and stayed up.
			if !st.Connected || st.Reconnects != 0 || st.LiveReconnects != 1 || st.LastError != "" {
				t.Fatalf("status = %+v", st)
			}
			// The log has the story, the server's word last.
			var kinds []string
			for _, e := range s.Log("c") {
				if e.Link == "live" {
					kinds = append(kinds, e.Kind)
				}
			}
			if strings.Join(kinds, ",") != "connected,disconnected,reconnected,reason" {
				t.Fatalf("live log = %v", kinds)
			}
			for _, e := range s.Log("c") {
				if e.Kind == "reason" && !strings.HasPrefix(e.Detail, "Slow Consumer (Pending Bytes) · the server sent ") {
					t.Fatalf("reason = %q", e.Detail)
				}
				if e.Kind == "disconnected" && !strings.Contains(e.Detail, "received ") {
					t.Fatalf("disconnected = %q", e.Detail)
				}
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no slow-consumer drop reported: %+v", s.GetStatus("c").LastDrop)
}

// A server that takes one connection per client gets one: the
// subscriptions share the API's connection and the status says why.
func TestLiveSharesTheConnectionWhenOnlyOneIsAllowed(t *testing.T) {
	ns := startSlowServer(t, &natsserver.Options{MaxConn: 1})
	s := NewStore()
	m, err := s.Connect(Config{ID: "c", Name: "c", Servers: []string{ns.ClientURL()}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Disconnect("c") })
	if m.LiveNC != nil || s.GetStatus("c").LiveError == "" {
		t.Fatalf("live = %v, error %q", m.LiveNC, m.LiveError)
	}
	if nc, err := s.GetLiveNC("c"); err != nil || nc != m.NC {
		t.Fatalf("GetLiveNC = %v, %v", nc, err)
	}
	if links := s.GetStatus("c").Links; len(links) != 1 || links[0].Name != "api" {
		t.Fatalf("links = %+v", links)
	}
}

// proxy stands between the explorer and a server: it can stall what the
// server sends, and cut every connection through it.
type proxy struct {
	addr    string
	stalled atomic.Bool
	mu      sync.Mutex
	conns   []net.Conn
}

func startProxy(t *testing.T, target string) *proxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	px := &proxy{addr: ln.Addr().String()}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", target)
			if err != nil {
				c.Close()
				continue
			}
			px.mu.Lock()
			px.conns = append(px.conns, c, up)
			px.mu.Unlock()
			go func() { io.Copy(up, c); up.Close() }()
			go func() {
				buf := make([]byte, 4096)
				for {
					for px.stalled.Load() {
						time.Sleep(10 * time.Millisecond)
					}
					n, err := up.Read(buf)
					if n > 0 {
						c.Write(buf[:n])
					}
					if err != nil {
						c.Close()
						return
					}
				}
			}()
		}
	}()
	return px
}

// cut closes every connection through the proxy, as a network that fails.
func (px *proxy) cut() {
	px.mu.Lock()
	defer px.mu.Unlock()
	for _, c := range px.conns {
		c.Close()
	}
	px.conns = nil
}
