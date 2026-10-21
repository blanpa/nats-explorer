package connection

import (
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// logSize is how many events a connection keeps: enough for a day of a
// flaky link, small enough not to matter when nobody looks.
const logSize = 200

// Event is one thing that happened to one of a connection's NATS
// connections. The connection log is what a user sends along with "it
// keeps disconnecting", so every line says which connection, which server,
// which client ID there, and what was said.
type Event struct {
	At int64 `json:"at"`
	// Link is the NATS connection: "api", "live" (the subscriptions') or
	// "system".
	Link string `json:"link"`
	// Kind is connected, disconnected, retrying (a reconnect attempt that
	// failed), reconnected, reason (the server's word on a drop, asked
	// afterwards), error (asynchronous, e.g. a permission violation),
	// lameduck (the server is going down), discovered (servers of the
	// cluster learnt), closed or failed.
	Kind   string `json:"kind"`
	Server string `json:"server,omitempty"`
	CID    uint64 `json:"cid,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// eventLog keeps the last logSize events of a connection ID. It belongs to
// the store, not to the connection, so it outlives a reconnect from the
// form and a disconnect; it is gone with the process.
type eventLog struct {
	mu     sync.Mutex
	events []Event
}

func (l *eventLog) add(e Event) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.events) == logSize {
		copy(l.events, l.events[1:])
		l.events = l.events[:logSize-1]
	}
	l.events = append(l.events, e)
}

func (l *eventLog) list() []Event {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]Event(nil), l.events...)
}

// maxLogs bounds how many connection IDs keep a log: every connect attempt
// from a form without an ID gets a new one, and a server that runs for
// months must not keep them all.
const maxLogs = 100

// logFor returns the log of a connection ID, starting one when needed; at
// maxLogs, the log of a closed connection that was quiet longest goes.
func (s *Store) logFor(connID string) *eventLog {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.logs[connID]
	if l == nil {
		if len(s.logs) >= maxLogs {
			s.dropQuietestLog()
		}
		l = &eventLog{}
		s.logs[connID] = l
	}
	return l
}

// dropQuietestLog removes the log of a connection that is not open and
// whose last event is the oldest. Callers hold s.mu.
func (s *Store) dropQuietestLog() {
	oldest, at := "", int64(0)
	for id, l := range s.logs {
		if _, open := s.connections[id]; open {
			continue
		}
		last := l.lastAt()
		if oldest == "" || last < at {
			oldest, at = id, last
		}
	}
	if oldest != "" {
		delete(s.logs, oldest)
	}
}

func (l *eventLog) lastAt() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.events) == 0 {
		return 0
	}
	return l.events[len(l.events)-1].At
}

// Log returns the events of a connection, oldest first; empty, not nil,
// when nothing happened yet.
func (s *Store) Log(connID string) []Event {
	s.mu.RLock()
	l := s.logs[connID]
	s.mu.RUnlock()
	if l == nil {
		return []Event{}
	}
	return l.list()
}

// record adds an event to the log and to the process output, where docker
// logs and the journal find it.
func record(l *eventLog, name string, e Event) {
	if e.At == 0 {
		e.At = time.Now().UnixMilli()
	}
	l.add(e)
	line := fmt.Sprintf("connection %s [%s] %s", name, e.Link, e.Kind)
	if e.Server != "" {
		line += " " + e.Server
	}
	if e.CID != 0 {
		line += fmt.Sprintf(" cid %d", e.CID)
	}
	if e.Detail != "" {
		line += ": " + e.Detail
	}
	log.Print(line)
}

// event records what happened to a link, naming the server and client ID
// it has now, or had last.
func (m *Managed) event(l *link, kind, detail string) {
	m.eventAt(l, kind, detail, time.Time{})
}

// eventAt is event for something that happened at a known time, written
// down later: a reconnect is logged once its round trip is measured.
func (m *Managed) eventAt(l *link, kind, detail string, at time.Time) {
	m.mu.Lock()
	e := Event{Link: l.name, Kind: kind, Server: l.url, CID: l.cid, Detail: scrubSecrets(detail, m.Config.Servers)}
	m.mu.Unlock()
	if !at.IsZero() {
		e.At = at.UnixMilli()
	}
	record(m.log, m.Config.Name, e)
}

// sample is one second's reading of a connection's counters.
type sample struct {
	at       time.Time
	in, msgs uint64
}

// rateWindow is how far back the rate at a drop looks: long enough to
// even out a burst, short enough to be about the drop.
const rateWindow = 5 * time.Second

// sampleRates reads the counters of the API and the live connection once a
// second, so a drop can say what was arriving just before it.
func (m *Managed) sampleRates(stop <-chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			for _, l := range []*link{&m.api, &m.live} {
				m.mu.Lock()
				nc := l.nc
				m.mu.Unlock()
				if nc == nil || !nc.IsConnected() {
					continue
				}
				st := nc.Stats()
				m.mu.Lock()
				l.samples = append(l.samples, sample{at: now, in: st.InBytes, msgs: st.InMsgs})
				if len(l.samples) > int(rateWindow/time.Second) {
					l.samples = l.samples[1:]
				}
				m.mu.Unlock()
			}
		}
	}
}

// down notes when a link was lost and describes the connection that ended:
// how long it was up, what it received, and at what rate just before; for
// the live connection also the pause it earned by dropping again soon.
func (m *Managed) down(l *link, err error) string {
	now := time.Now()
	m.mu.Lock()
	l.downAt, l.attempts, l.retryErr = now, 0, ""
	nc, since, base := l.nc, l.since, l.base
	var first *sample
	if len(l.samples) > 0 {
		f := l.samples[0]
		first = &f
	}
	m.mu.Unlock()

	parts := []string{err.Error()}
	if nc != nil && !since.IsZero() {
		st := nc.Stats()
		parts = append(parts, "up "+fmtDuration(now.Sub(since)))
		switch {
		case st.InMsgs == base.InMsgs:
			parts = append(parts, "received nothing")
		default:
			parts = append(parts, fmt.Sprintf("received %d msgs, %s", st.InMsgs-base.InMsgs, fmtBytes(int64(st.InBytes-base.InBytes))))
			if first != nil && st.InMsgs > first.msgs {
				if secs := now.Sub(first.at).Seconds(); secs >= 1 {
					parts = append(parts, fmt.Sprintf("%s/s, %.0f msg/s in the last %.0f s",
						fmtBytes(int64(float64(st.InBytes-first.in)/secs)), float64(st.InMsgs-first.msgs)/secs, secs))
				}
			}
		}
	}
	if l.name == "live" {
		if flaps := m.noteDrop(l, now); livePause(flaps) > 0 {
			parts = append(parts, fmt.Sprintf("next attempt in %s: dropped within %.0f s of connecting, %d× in a row",
				fmtDuration(livePause(flaps)), flapWindow.Seconds(), flaps))
		}
	}
	return strings.Join(parts, " · ")
}

// back describes a reconnect: how long the link was down and how many
// attempts it took.
func (m *Managed) back(l *link, now time.Time) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if l.downAt.IsZero() {
		return ""
	}
	// nats.go reports the attempts whose dial fails; one that reaches a
	// server and is turned away goes uncounted, so they are only named
	// when there are some.
	d := "after " + fmtDuration(now.Sub(l.downAt))
	if l.attempts > 0 {
		d += fmt.Sprintf(", %d failed attempts before (the last: %s)", l.attempts, l.retryErr)
	}
	l.downAt, l.attempts, l.retryErr = time.Time{}, 0, ""
	return d
}

// retried counts a failed reconnect attempt and says whether it is worth a
// line: the first, one whose error is new, and every 30th, so an outage of
// an hour does not push everything else out of the log.
func (m *Managed) retried(l *link, err error) (int, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l.attempts++
	changed := err.Error() != l.retryErr
	l.retryErr = err.Error()
	return l.attempts, l.attempts == 1 || changed || l.attempts%30 == 0
}

// announce logs the first connect of a link, once: right after the dial,
// or -- for a connection that keeps trying to reach its server from the
// start -- when nats.go reports it connected. nats.go reports every first
// connect on a goroutine of its own, so both can come at once; the second
// waits until the first has written it down, and a connect has been logged
// by the time it returns, before anything that comes after it.
func (m *Managed) announce(l *link, nc *nats.Conn) {
	l.announceMu.Lock()
	defer l.announceMu.Unlock()
	m.mu.Lock()
	if l.announced {
		m.mu.Unlock()
		return
	}
	l.announced = true
	if l.name == "api" {
		m.ConnectedAt = time.Now()
		m.apiUp.Store(true)
	}
	m.mu.Unlock()
	m.remember(l, nc)
	m.event(l, "connected", m.connectedDetail(l, nc))
}

// connectedDetail describes the server a connection reached and how: name,
// version, cluster, TLS, authentication, bastion, and the round trip.
func (m *Managed) connectedDetail(l *link, nc *nats.Conn) string {
	var parts []string
	if n := nc.ConnectedServerName(); n != "" {
		parts = append(parts, "server "+n)
	}
	if v := nc.ConnectedServerVersion(); v != "" {
		parts = append(parts, "v"+v)
	}
	if c := nc.ConnectedClusterName(); c != "" {
		parts = append(parts, "cluster "+c)
	}
	if cs, err := nc.TLSConnectionState(); err == nil && cs.HandshakeComplete {
		parts = append(parts, tls.VersionName(cs.Version))
	}
	auth := m.Config.AuthMethod
	if l.name == "system" {
		auth = m.Config.SysAuthMethod
	}
	if auth != "" && auth != "none" {
		parts = append(parts, "auth "+auth)
	}
	if m.tunnel != nil && m.Config.SSH != nil {
		parts = append(parts, "via SSH "+m.Config.SSH.Host)
	}
	// The round trip goes behind whatever the server is still sending, so
	// on a busy live connection it is also a measure of the backlog.
	if rtt, err := nc.RTT(); err == nil {
		parts = append(parts, "rtt "+fmtDuration(rtt))
	}
	return strings.Join(parts, " · ")
}

// redactURLs turns server URLs into what may be shown and logged: a
// password in one (nats://user:secret@host) is replaced, as nats.go does
// for the connected URL.
func redactURLs(servers []string) []string {
	out := make([]string, len(servers))
	for i, raw := range servers {
		out[i] = raw
		if u, err := url.Parse(raw); err == nil && u.User != nil {
			if _, has := u.User.Password(); has {
				out[i] = u.Redacted()
			}
		}
	}
	return out
}

// scrubSecrets removes the passwords of the server URLs from a text that
// may quote one, such as an error about a URL that does not parse.
func scrubSecrets(text string, servers []string) string {
	for _, raw := range servers {
		if i := strings.Index(raw, "://"); i >= 0 {
			if at := strings.LastIndex(raw, "@"); at > i {
				if c := strings.Index(raw[i+3:at], ":"); c >= 0 {
					if pass := raw[i+3+c+1 : at]; pass != "" {
						text = strings.ReplaceAll(text, pass, "xxxxx")
					}
				}
			}
		}
	}
	return text
}

func fmtBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

// fmtDuration rounds a duration to what a reader needs: microseconds for a
// round trip, tenths of seconds for an outage, seconds for an uptime.
func fmtDuration(d time.Duration) string {
	switch {
	case d < time.Millisecond:
		return d.Round(time.Microsecond).String()
	case d < time.Second:
		return d.Round(100 * time.Microsecond).String()
	case d < time.Minute:
		return d.Round(100 * time.Millisecond).String()
	}
	return d.Round(time.Second).String()
}

// handlers are the callbacks every NATS connection of a Managed gets: they
// keep the log, the drop bookkeeping and, for the API connection, the
// error the UI shows.
func (m *Managed) handlers(l *link, notify func()) []nats.Option {
	opts := []nats.Option{
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			// Without an error it is a Close, which the closed handler logs.
			if err == nil {
				return
			}
			if l.name == "api" {
				m.setError(l.name, err)
				m.apiUp.Store(false)
			}
			m.event(l, "disconnected", m.down(l, err))
			if l.name != "system" {
				m.dropped(l, err)
			}
			notify()
		}),
		nats.ReconnectErrHandler(func(_ *nats.Conn, err error) {
			if n, worth := m.retried(l, err); worth {
				m.event(l, "retrying", fmt.Sprintf("attempt %d failed: %s", n, err))
			}
		}),
		nats.ConnectHandler(func(nc *nats.Conn) {
			// The first connect of one that kept trying from the start;
			// otherwise announce has done it already.
			m.announce(l, nc)
			notify()
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			at := time.Now()
			if l.name == "api" {
				m.apiUp.Store(true)
			}
			if l.name != "system" {
				m.setError(l.name, nil)
			}
			outage := m.back(l, at)
			m.remember(l, nc)
			notify()
			// The round trip takes a moment and the server's reason a
			// request; neither holds up nats.go's callbacks.
			go func() {
				detail := m.connectedDetail(l, nc)
				if outage != "" {
					detail = outage + " · " + detail
				}
				m.eventAt(l, "reconnected", detail, at)
				// The client saw a closed socket; the server knows whether
				// it closed it, and why.
				if l.name != "system" && m.explainDrop(l) {
					notify()
				}
			}()
		}),
		nats.ClosedHandler(func(_ *nats.Conn) {
			if l.name == "api" {
				m.apiUp.Store(false)
			}
			m.mu.Lock()
			note := l.closeNote
			l.closeNote = ""
			m.mu.Unlock()
			m.event(l, "closed", note)
			notify()
		}),
		nats.LameDuckModeHandler(func(_ *nats.Conn) {
			if l.name == "live" {
				m.lameDuckNoted(l)
			}
			m.event(l, "lameduck", "the server is shutting down and asks its clients to move to another server")
		}),
		nats.ErrorHandler(func(_ *nats.Conn, sub *nats.Subscription, err error) {
			// A permission refused is worth showing until it is fixed; a
			// slow consumer passes, and the log has it.
			if l.name != "system" && !errors.Is(err, nats.ErrSlowConsumer) {
				m.setError(l.name, err)
			}
			detail := err.Error()
			if sub != nil {
				detail += " (subscription " + sub.Subject + ")"
				// A slow consumer on the explorer's side: how far behind it
				// is, against what it may hold before it drops.
				if errors.Is(err, nats.ErrSlowConsumer) {
					msgs, bytes, _ := sub.Pending()
					maxMsgs, maxBytes, _ := sub.PendingLimits()
					dropped, _ := sub.Dropped()
					detail += fmt.Sprintf(" · %d msgs, %s waiting in the explorer (limit %d msgs, %s) · %d dropped so far",
						msgs, fmtBytes(int64(bytes)), maxMsgs, fmtBytes(int64(maxBytes)), dropped)
				}
			}
			m.event(l, "error", detail)
		}),
	}
	// The cluster's servers are the same whichever connection learns them.
	if l.name == "api" {
		opts = append(opts, nats.DiscoveredServersHandler(func(nc *nats.Conn) {
			m.event(l, "discovered", "servers of the cluster now known: "+strings.Join(nc.DiscoveredServers(), ", "))
		}))
	}
	return opts
}
