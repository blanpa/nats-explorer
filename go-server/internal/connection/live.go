package connection

import (
	"fmt"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
)

// The subscriptions' connection carries the traffic, so it is the one a
// server drops when the explorer cannot keep up -- and the one that comes
// straight back, subscribes to the same patterns and is dropped again,
// costing the server a full pending buffer each round. It backs off
// instead: a drop within flapWindow of connecting counts as a flap, and
// from the second flap in a row on each doubles the pause before the next
// attempt, up to maxLivePause; a connection that stays up longer ends the
// series. The first drop never waits: a server that goes away shortly
// after the explorer connected -- a restart, a failover to another node
// of the cluster -- is followed at once, as nats.go would.
const (
	reconnectWait = 2 * time.Second
	flapWindow    = time.Minute
	maxLivePause  = time.Minute
)

// livePause is the wait before the next attempt after flaps in a row: none
// for the first, then 4 s, 8 s, 16 s, ... up to maxLivePause.
func livePause(flaps int) time.Duration {
	if flaps <= 1 {
		return 0
	}
	d := reconnectWait
	for i := 1; i < flaps && d < maxLivePause; i++ {
		d *= 2
	}
	return min(d, maxLivePause)
}

// noteDrop counts a drop of the live connection, once per drop: whichever
// comes first, the disconnect callback or nats.go asking for the next
// server, does it. A drop within flapWindow of connecting is a flap and
// earns a pause; one after a longer uptime ends the series. Returns the
// flaps in a row.
func (m *Managed) noteDrop(l *link, now time.Time) int {
	m.policyMu.Lock()
	defer m.policyMu.Unlock()
	m.noteDropLocked(l, now)
	return l.flaps
}

func (m *Managed) noteDropLocked(l *link, now time.Time) {
	if l.dropNoted {
		return
	}
	l.dropNoted = true
	switch {
	case l.lameDuck:
		// The server said it was going: a rolling restart, not the
		// explorer's load. Followed at once, and the series is over.
		l.flaps = 0
	case l.upSince.IsZero() || now.Sub(l.upSince) > flapWindow:
		l.flaps = 0
	default:
		l.flaps++
	}
	l.lameDuck = false
	l.pausedUntil = now.Add(livePause(l.flaps))
}

// notFlap takes back the flap counted for a drop once the server says it
// was not the explorer's load -- a shutdown, a restart, the explorer's own
// close: only a slow consumer, or a drop nobody explained, keeps counting.
func (m *Managed) notFlap(l *link) {
	m.policyMu.Lock()
	defer m.policyMu.Unlock()
	if l.flaps > 0 {
		l.flaps--
	}
}

// lameDuckNoted marks that the server announced its shutdown, so the drop
// that follows is not counted against the live connection.
func (m *Managed) lameDuckNoted(l *link) {
	m.policyMu.Lock()
	l.lameDuck = true
	m.policyMu.Unlock()
}

// nextLiveServer picks the server of the live connection's next attempt and
// how long to wait first: the servers in turn, none tried again within
// reconnectWait (what nats.go does on its own), and not before the pause
// after a series of flaps is over. nats.go calls it holding its own lock,
// so it takes only the policy lock.
func (m *Managed) nextLiveServer(servers []nats.Server, _ nats.ServerInfo) (*nats.Server, time.Duration) {
	if len(servers) == 0 {
		return nil, 0
	}
	m.policyMu.Lock()
	defer m.policyMu.Unlock()
	l := &m.live
	now := time.Now()
	// This may be the first word of the drop: the disconnect callback
	// runs on another goroutine and can come later.
	m.noteDropLocked(l, now)
	if l.tried == nil {
		l.tried = make(map[string]time.Time)
	}
	// Attempts that keep failing while the API's connection to the same
	// servers stands mean the server will not take this one -- its
	// connection limit, or the account's, is reached; a full round and two
	// more are enough to tell that from a server that is briefly away. The
	// refusal itself never reaches the client: nats.go reports failed
	// dials, not a handshake the server turned down. Being asked again
	// means the last attempt failed; it counts only when the API's
	// connection was up both then and now, so an outage of the whole
	// cluster does not count.
	apiUp := m.apiUp.Load()
	if l.tries > 0 && l.lastTryAPIUp && apiUp {
		l.failedWhileAPIUp++
	} else if !apiUp {
		l.failedWhileAPIUp = 0
	}
	l.tries++
	l.lastTryAPIUp = apiUp
	if failed := l.failedWhileAPIUp; failed >= len(servers)+2 && !l.moving {
		l.moving = true
		go m.moveLive(fmt.Errorf("the server did not take it back in %d attempts while the API's connection stands", failed))
	}
	l.next = (l.next + 1) % len(servers)
	srv := &servers[l.next]
	wait := time.Duration(0)
	if last, ok := l.tried[srv.URL.String()]; ok {
		wait = max(reconnectWait-now.Sub(last), 0)
	}
	wait = max(wait, l.pausedUntil.Sub(now))
	l.tried[srv.URL.String()] = now.Add(wait)
	return srv, wait
}

// liveConn returns the subscriptions' own connection, nil when there is
// none, and why not when the server refused it.
func (m *Managed) liveConn() (*nats.Conn, string) {
	m.liveMu.Lock()
	defer m.liveMu.Unlock()
	return m.LiveNC, m.LiveError
}

// openLive dials the subscriptions' connection unless it is open or the
// server refused it. A refusal is not fatal: the subscriptions share the
// API's connection then, as they did before there was a second one.
//
// Reopened later -- the first pattern after all were removed -- it keeps
// trying a server that is away at that moment instead of giving up for
// good; the subscriptions wait on it, and a server that will not take it
// is noticed as on any reconnect (nextLiveServer).
func (m *Managed) openLive() *nats.Conn {
	m.liveMu.Lock()
	if m.LiveNC != nil && !m.LiveNC.IsClosed() {
		defer m.liveMu.Unlock()
		return m.LiveNC
	}
	if m.LiveError != "" || m.liveOpts == nil {
		m.liveMu.Unlock()
		return nil
	}
	m.liveMu.Unlock()

	// Dialled outside the lock: the status reads the live connection, and
	// a dial may take its timeout.
	m.mu.Lock()
	m.live.announced = false
	m.mu.Unlock()
	m.policyMu.Lock()
	m.live.flaps, m.live.pausedUntil, m.live.tries, m.live.failedWhileAPIUp, m.live.moving = 0, time.Time{}, 0, 0, false
	reopen := m.live.opened
	m.live.opened = true
	m.policyMu.Unlock()
	opts := m.liveOpts
	if reopen {
		opts = append(append([]nats.Option(nil), opts...), nats.RetryOnFailedConnect(true))
	}
	nc, err := nats.Connect(strings.Join(m.Config.Servers, ","), opts...)

	m.liveMu.Lock()
	if m.LiveNC != nil && !m.LiveNC.IsClosed() {
		// Someone else was quicker.
		defer m.liveMu.Unlock()
		if err == nil {
			nc.Close()
		}
		return m.LiveNC
	}
	if err != nil {
		m.LiveError = err.Error()
		m.liveMu.Unlock()
		m.event(&m.live, "failed", "no connection of its own, the subscriptions share the API's: "+err.Error())
		return nil
	}
	m.LiveNC = nc
	m.liveMu.Unlock()
	// Outside the lock: it measures a round trip.
	if nc.IsConnected() {
		m.announce(&m.live, nc)
	}
	return nc
}

// closeLive closes the subscriptions' connection, saying why in the log.
func (m *Managed) closeLive(why string) {
	m.liveMu.Lock()
	nc := m.LiveNC
	m.LiveNC = nil
	m.liveMu.Unlock()
	if nc == nil {
		return
	}
	m.mu.Lock()
	m.live.closeNote = why
	m.mu.Unlock()
	nc.Close()
}

// moveLive gives up the subscriptions' own connection when the server will
// not take it back, and has the subscriptions move
// to the API's connection. A refusal at the first connect is handled by
// openLive; this is the one that comes later, when another client took the
// last slot while the live connection was away.
func (m *Managed) moveLive(err error) {
	m.liveMu.Lock()
	m.LiveError = err.Error()
	m.liveMu.Unlock()
	m.closeLive(err.Error() + "; the subscriptions move to the API's connection")
	if m.onLiveMoved != nil {
		m.onLiveMoved()
	}
}

// ReleaseLive closes the subscriptions' connection of a connection that no
// longer subscribes to anything, so it does not hold a slot of the
// server's or the account's connection limit; the next pattern opens it
// again (GetLiveNC).
func (s *Store) ReleaseLive(connID string) {
	if m, ok := s.Get(connID); ok {
		m.closeLive("no subscriptions left; it opens again with the next one")
		s.notify()
	}
}

// SetOnLiveMoved registers what moves the subscriptions of a connection to
// its API connection once the live one is given up.
func (s *Store) SetOnLiveMoved(fn func(connID string)) {
	s.onLiveMoved = fn
}
