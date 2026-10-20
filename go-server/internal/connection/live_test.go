package connection

import (
	"errors"
	"net"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

func TestLivePause(t *testing.T) {
	for flaps, want := range map[int]time.Duration{0: 0, 1: 0, 2: 4 * time.Second, 3: 8 * time.Second, 5: 32 * time.Second, 6: time.Minute, 9: time.Minute} {
		if got := livePause(flaps); got != want {
			t.Errorf("livePause(%d) = %s, want %s", flaps, got, want)
		}
	}
}

// A drop soon after connecting counts as a flap and earns a pause, one
// after a long uptime ends the series; the next server waits for the pause.
func TestLiveFlapsAndNextServer(t *testing.T) {
	m := &Managed{}
	now := time.Now()
	drop := func(up time.Duration) int {
		m.live.upSince, m.live.dropNoted = now.Add(-up), false
		return m.noteDrop(&m.live, now)
	}
	drop(10 * time.Second)
	if drop(5*time.Second) != 2 || m.live.pausedUntil.Sub(now) != 4*time.Second {
		t.Fatalf("flaps %d, pause %s", m.live.flaps, m.live.pausedUntil.Sub(now))
	}
	if m.noteDrop(&m.live, now) != 2 {
		t.Fatal("a drop is counted once, whoever reports it")
	}
	servers := []nats.Server{{URL: mustURL(t, "nats://a:4222")}, {URL: mustURL(t, "nats://b:4222")}}
	srv, wait := m.nextLiveServer(servers, nats.ServerInfo{})
	if srv == nil || wait < 3*time.Second {
		t.Fatalf("next = %v after %s", srv, wait)
	}
	if drop(2*flapWindow) != 0 || m.live.pausedUntil.After(now) {
		t.Fatalf("a long uptime must end the series: flaps %d", m.live.flaps)
	}
	// The other server is tried at once, the same one not within
	// reconnectWait of its last attempt.
	if srv2, wait := m.nextLiveServer(servers, nats.ServerInfo{}); srv2.URL.String() == srv.URL.String() || wait != 0 {
		t.Fatalf("second = %v after %s", srv2.URL, wait)
	}
}

// When the network fails, the live connection follows at once the first
// time; failing again soon after, it waits while the API's connection comes
// back at nats.go's pace, and the log and the status say so.
func TestLiveBacksOffAfterADropSoonAfterConnecting(t *testing.T) {
	ns := startNATS(t)
	px := startProxy(t, ns.Addr().String())
	s := NewStore()
	if _, err := s.Connect(Config{ID: "c", Name: "c", Servers: []string{"nats://" + px.addr}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Disconnect("c") })

	// back measures how long after a cut each connection is up again.
	back := func(wantReconnects uint64) (api, live time.Duration, paused bool) {
		t.Helper()
		px.cut()
		cut := time.Now()
		deadline := cut.Add(10 * time.Second)
		for time.Now().Before(deadline) && (api == 0 || live == 0) {
			st := s.GetStatus("c")
			paused = paused || st.LivePauseMs > 0
			for _, l := range st.Links {
				if l.Reconnects >= wantReconnects && l.Connected {
					if l.Name == "api" && api == 0 {
						api = time.Since(cut)
					}
					if l.Name == "live" && live == 0 {
						live = time.Since(cut)
					}
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		return api, live, paused
	}
	if api, live, paused := back(1); live == 0 || live > 3500*time.Millisecond || paused || api == 0 {
		t.Fatalf("first cut: api back after %s, live after %s, paused %v", api, live, paused)
	}
	if api, live, paused := back(2); api == 0 || api > 3500*time.Millisecond || live < 3900*time.Millisecond || !paused {
		t.Fatalf("second cut: api back after %s, live after %s, paused %v", api, live, paused)
	}
	found := false
	for _, e := range s.Log("c") {
		found = found || (e.Link == "live" && e.Kind == "disconnected" && strings.Contains(e.Detail, "next attempt in 4s"))
	}
	if !found {
		t.Fatalf("the pause is not in the log: %+v", s.Log("c"))
	}
}

// A connection opened with Retry does not fail on a server that is not
// there yet: it reconnects in the background and announces the connect
// when the server comes.
func TestRetryOnAServerThatComesLater(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	s := NewStore()
	m, err := s.Connect(Config{ID: "c", Name: "c", Servers: []string{"nats://" + ln.Addr().String()}, Retry: true})
	if err != nil {
		t.Fatalf("a retried connect must not fail: %v", err)
	}
	t.Cleanup(func() { s.Disconnect("c") })
	if st := s.GetStatus("c"); st.Connected || !st.Reconnecting {
		t.Fatalf("status before the server = %+v", st)
	}
	if nc, err := s.GetLiveNC("c"); err != nil || nc != m.LiveNC {
		t.Fatalf("the subscriptions need their connection before it connects: %v %v", nc, err)
	}

	ns, err := natsserver.NewServer(&natsserver.Options{Host: "127.0.0.1", Port: port, NoLog: true, NoSigs: true})
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	t.Cleanup(ns.Shutdown)
	// The connect is logged once its round trip is measured, a moment
	// after the status says so.
	deadline := time.Now().Add(10 * time.Second)
	var joined string
	for time.Now().Before(deadline) {
		var kinds []string
		for _, e := range s.Log("c") {
			kinds = append(kinds, e.Link+" "+e.Kind)
		}
		joined = strings.Join(kinds, ",")
		st := s.GetStatus("c")
		if st.Connected && st.ConnectedAt > 0 && len(st.Links) == 2 && st.Links[1].Connected &&
			strings.Contains(joined, "api connected") && strings.Contains(joined, "live connected") {
			if !strings.Contains(joined, "api retrying") || strings.Count(joined, "api connected") != 1 {
				t.Fatalf("log = %s", joined)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Logf("log = %s", joined)
	t.Fatalf("never connected: %+v", s.GetStatus("c"))
}

// Without subscriptions the live connection is let go, and the next pattern
// opens it again.
func TestReleaseAndReopenLive(t *testing.T) {
	ns := startNATS(t)
	s := NewStore()
	if _, err := s.Connect(Config{ID: "c", Name: "c", Servers: []string{ns.ClientURL()}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Disconnect("c") })
	s.ReleaseLive("c")
	waitClients(t, ns, 1)
	if links := s.GetStatus("c").Links; len(links) != 1 {
		t.Fatalf("links after release = %+v", links)
	}
	nc, err := s.GetLiveNC("c")
	if m, _ := s.Get("c"); err != nil || nc == m.NC {
		t.Fatalf("GetLiveNC must open a connection of its own: %v", err)
	}
	waitClients(t, ns, 2)
	closed := false
	for _, e := range s.Log("c") {
		closed = closed || (e.Link == "live" && e.Kind == "closed" && strings.Contains(e.Detail, "no subscriptions left"))
	}
	if !closed {
		t.Fatalf("the release is not in the log: %+v", s.Log("c"))
	}
}

// A live connection the server keeps refusing is given up: the
// subscriptions are moved, the status says why, and it is not reopened.
func TestMoveLiveToTheAPIConnection(t *testing.T) {
	ns := startNATS(t)
	s := NewStore()
	var moved atomic.Value
	s.SetOnLiveMoved(func(id string) { moved.Store(id) })
	if _, err := s.Connect(Config{ID: "c", Name: "c", Servers: []string{ns.ClientURL()}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Disconnect("c") })
	m, _ := s.Get("c")
	m.moveLive(errors.New("nats: maximum connections exceeded"))

	if moved.Load() != "c" {
		t.Fatal("the subscriptions were not moved")
	}
	st := s.GetStatus("c")
	if !strings.Contains(st.LiveError, "maximum connections exceeded") || len(st.Links) != 1 {
		t.Fatalf("status = %+v", st)
	}
	if nc, _ := s.GetLiveNC("c"); nc != m.NC {
		t.Fatal("a refused live connection must not be reopened")
	}
	waitClients(t, ns, 1)
}

func waitClients(t *testing.T, ns *natsserver.Server, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for ns.NumClients() != n && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if got := ns.NumClients(); got != n {
		t.Fatalf("server sees %d clients, want %d", got, n)
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// When another client takes the last slot while the live connection is
// away, the server keeps turning it away; after a few refusals it is given
// up and the subscriptions move to the API connection.
func TestLiveMovesWhenTheServerIsFull(t *testing.T) {
	ns := startSlowServer(t, &natsserver.Options{MaxConn: 2})
	px := startProxy(t, ns.Addr().String())
	s := NewStore()
	var moved atomic.Value
	s.SetOnLiveMoved(func(id string) { moved.Store(id) })
	if _, err := s.Connect(Config{ID: "c", Name: "c", Servers: []string{"nats://" + px.addr}}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Disconnect("c") })
	waitClients(t, ns, 2)

	// As after an earlier drop: this one is the second in a row and waits,
	// which leaves the slot to the other client.
	m, _ := s.Get("c")
	m.policyMu.Lock()
	m.live.flaps = 1
	m.policyMu.Unlock()
	px.cut()
	// The API connection is back first; then the slot is taken.
	deadline := time.Now().Add(5 * time.Second)
	for !s.GetStatus("c").Connected && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	other, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatalf("the other client: %v", err)
	}
	defer other.Close()

	deadline = time.Now().Add(20 * time.Second)
	for moved.Load() == nil && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if moved.Load() != "c" {
		t.Fatalf("not moved: %+v, log %+v", s.GetStatus("c"), s.Log("c"))
	}
	st := s.GetStatus("c")
	if st.LiveError == "" || len(st.Links) != 1 || !st.Connected {
		t.Fatalf("status = %+v", st)
	}
	closed := false
	for _, e := range s.Log("c") {
		closed = closed || (e.Link == "live" && e.Kind == "closed" && strings.Contains(e.Detail, "move to the API's connection"))
	}
	if !closed {
		t.Fatalf("the move is not in the log: %+v", s.Log("c"))
	}
}
