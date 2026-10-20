package connection

import (
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
)

func TestEventLogKeepsTheNewest(t *testing.T) {
	var l eventLog
	for i := 0; i < logSize+5; i++ {
		l.add(Event{CID: uint64(i)})
	}
	got := l.list()
	if len(got) != logSize || got[0].CID != 5 || got[logSize-1].CID != logSize+4 {
		t.Fatalf("kept %d, first %d, last %d", len(got), got[0].CID, got[len(got)-1].CID)
	}
}

// A connection's log names each of its NATS connections as it comes up, a
// connect that fails, and the close; it outlives the connection.
func TestConnectionLog(t *testing.T) {
	ns := startNATS(t)
	s := NewStore()
	if _, err := s.Connect(Config{ID: "c", Name: "lab", Servers: []string{"nats://127.0.0.1:1"}}); err == nil {
		t.Fatal("connect to a closed port must fail")
	}
	if _, err := s.Connect(Config{ID: "c", Name: "lab", Servers: []string{ns.ClientURL()}}); err != nil {
		t.Fatal(err)
	}
	// The status lists the NATS connections open for it, as the server does.
	links := s.GetStatus("c").Links
	if len(links) != 2 || links[0].Name != "api" || links[1].Name != "live" || !links[1].Connected || links[1].CID == 0 || links[1].Since == 0 {
		t.Fatalf("links = %+v", links)
	}
	if n := ns.NumClients(); n != 2 {
		t.Fatalf("server sees %d clients", n)
	}
	s.Disconnect("c")

	// nats.go reports the closes on goroutines of their own, in any order.
	want := "api failed,api connected,live connected,api closed+live closed"
	deadline := time.Now().Add(5 * time.Second)
	var got string
	for time.Now().Before(deadline) {
		var kinds []string
		for _, e := range s.Log("c") {
			kinds = append(kinds, e.Link+" "+e.Kind)
		}
		if len(kinds) == 5 && kinds[3] > kinds[4] {
			kinds[3], kinds[4] = kinds[4], kinds[3]
		}
		got = strings.Join(kinds, ",")
		if len(kinds) == 5 {
			got = strings.Join(kinds[:4], ",") + "+" + kinds[4]
		}
		if got == want {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if got != want {
		t.Fatalf("log = %v, want %v", got, want)
	}
	log := s.Log("c")
	if !strings.Contains(log[0].Detail, "127.0.0.1:1") || log[1].Server == "" || log[1].CID == 0 {
		t.Fatalf("events lack their details: %+v", log[:2])
	}
	if l := s.Log("unknown"); l == nil || len(l) != 0 {
		t.Fatalf("unknown connection: %v", l)
	}
}

// A server that goes down says so first (lame duck mode); the drop says
// how long the connection was up and what it received, the failed
// attempts are logged, and the reconnect says how long it took.
func TestConnectionLogOutage(t *testing.T) {
	opts := &natsserver.Options{Host: "127.0.0.1", Port: -1, NoLog: true, NoSigs: true, LameDuckDuration: time.Second, LameDuckGracePeriod: -time.Second}
	ns, err := natsserver.NewServer(opts)
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats-server did not start")
	}
	port := ns.Addr().(*net.TCPAddr).Port

	s := NewStore()
	m, err := s.Connect(Config{ID: "c", Name: "c", Servers: []string{ns.ClientURL()}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Disconnect("c") })
	m.NC.Publish("x", []byte("hello"))
	go ns.LameDuckShutdown()

	waitFor := func(link, kind, contains string) Event {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for time.Now().Before(deadline) {
			for _, e := range s.Log("c") {
				if e.Link == link && e.Kind == kind && strings.Contains(e.Detail, contains) {
					return e
				}
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("no %s %s %q in %+v", link, kind, contains, s.Log("c"))
		return Event{}
	}
	if e := waitFor("api", "connected", "rtt "); !strings.Contains(e.Detail, "server ") || !strings.Contains(e.Detail, "v2.") {
		t.Fatalf("connected = %q", e.Detail)
	}
	waitFor("api", "lameduck", "shutting down")
	waitFor("api", "disconnected", "received nothing")
	waitFor("api", "retrying", "attempt 1 failed")

	ns2, err := natsserver.NewServer(&natsserver.Options{Host: "127.0.0.1", Port: port, NoLog: true, NoSigs: true})
	if err != nil {
		t.Fatal(err)
	}
	go ns2.Start()
	t.Cleanup(ns2.Shutdown)
	e := waitFor("api", "reconnected", "after ")
	if !strings.Contains(e.Detail, "failed attempts before (the last: ") || !strings.Contains(e.Detail, "rtt ") {
		t.Fatalf("reconnected = %q", e.Detail)
	}
}

func TestFmtBytes(t *testing.T) {
	for n, want := range map[int64]string{0: "0 B", 1023: "1023 B", 1024: "1.0 KB", 64 << 20: "64.0 MB", 3 << 30: "3.0 GB"} {
		if got := fmtBytes(n); got != want {
			t.Errorf("fmtBytes(%d) = %q, want %q", n, got, want)
		}
	}
}

// A password in a server URL never reaches the log: not in the list of
// servers a failed connect names, not where an error quotes the URL.
func TestConnectionLogHidesURLPasswords(t *testing.T) {
	s := NewStore()
	if _, err := s.Connect(Config{ID: "c", Name: "c", Servers: []string{"nats://alice:s3cr3t-pw@127.0.0.1:1"}}); err == nil {
		t.Fatal("connect to a closed port must fail")
	}
	for _, e := range s.Log("c") {
		if strings.Contains(e.Detail, "s3cr3t-pw") || strings.Contains(e.Server, "s3cr3t-pw") {
			t.Fatalf("password in the log: %+v", e)
		}
		if !strings.Contains(e.Detail, "alice:xxxxx@127.0.0.1:1") {
			t.Fatalf("the server is not named: %+v", e)
		}
	}
	if got := scrubSecrets(`parse "nats://bob:hunter2@h:x": invalid port`, []string{"nats://bob:hunter2@h:x"}); strings.Contains(got, "hunter2") {
		t.Fatalf("scrubSecrets = %q", got)
	}
}

// The logs of closed connections are bounded; the quietest goes first.
func TestLogsAreBounded(t *testing.T) {
	s := NewStore()
	for i := 0; i < maxLogs+10; i++ {
		l := s.logFor(fmt.Sprintf("id-%d", i))
		l.add(Event{At: int64(i + 1)})
	}
	if len(s.logs) != maxLogs {
		t.Fatalf("%d logs kept, want %d", len(s.logs), maxLogs)
	}
	if _, kept := s.logs["id-0"]; kept {
		t.Fatal("the quietest log must go first")
	}
	if _, kept := s.logs[fmt.Sprintf("id-%d", maxLogs+9)]; !kept {
		t.Fatal("the newest log must stay")
	}
}
