package connection

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
)

// Drop is the last time the connection was lost, and why. The client only
// sees the socket close ("EOF"); the server knows the reason and is asked
// for it once the connection is back.
type Drop struct {
	At     int64  `json:"at"`
	Reason string `json:"reason"`
	// SlowConsumer: the server closed the connection because the explorer
	// did not take the messages its subscriptions match as fast as they
	// came, over this link.
	SlowConsumer bool `json:"slowConsumer,omitempty"`
	// Live: it was the connection of the subscriptions that was lost; the
	// API's stayed up.
	Live bool `json:"live,omitempty"`
}

const defaultMonitoringPort = 8222

// MonitoringBase derives the HTTP monitoring endpoint from the connection
// config: an explicit URL wins, then an explicit port, then 8222 on the host
// of the first server URL.
func MonitoringBase(cfg Config) (string, error) {
	if cfg.MonitoringURL != "" {
		return strings.TrimRight(cfg.MonitoringURL, "/"), nil
	}
	if len(cfg.Servers) == 0 {
		return "", fmt.Errorf("no server configured")
	}

	raw := cfg.Servers[0]
	if !strings.Contains(raw, "://") {
		raw = "nats://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("cannot parse server url: %w", err)
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("cannot determine host from %q", cfg.Servers[0])
	}

	port := cfg.MonitoringPort
	if port == 0 {
		port = defaultMonitoringPort
	}
	return fmt.Sprintf("http://%s", net.JoinHostPort(host, strconv.Itoa(port))), nil
}

// link is what is known about one of a connection's NATS connections for
// explaining its drops: the server and client ID it has now, and those of
// the one lost last until its server has been asked. Guarded by Managed.mu.
type link struct {
	// name is "api", "live" or "system"
	name          string
	serverID      string
	url           string
	cid           uint64
	pendingServer string
	pendingURL    string
	pendingCID    uint64
	// pendingIn is how many messages the lost connection received, to
	// hold against what the server says it sent; pendingDrop is its drop
	pendingIn   uint64
	pendingDrop *Drop

	// for the connection log (log.go): the connection now, since when, its
	// counters then, the last seconds of them, and the reconnect underway
	nc       *nats.Conn
	since    time.Time
	base     nats.Statistics
	samples  []sample
	downAt   time.Time
	attempts int
	retryErr string
	// announced: its first connect is logged (announce)
	announced bool
	// closeNote says why the explorer closed it, for the log
	closeNote string

	// the live connection's reconnect policy (live.go), guarded by
	// Managed.policyMu: since when it is up, whether its drop is counted,
	// the attempts since, whether it is being given up, drops in a row
	// soon after connecting, the pause they earned, the server tried last
	// and when each was tried
	upSince          time.Time
	dropNoted        bool
	lameDuck         bool
	tries            int
	lastTryAPIUp     bool
	failedWhileAPIUp int
	moving           bool
	opened           bool
	flaps            int
	pausedUntil      time.Time
	next             int
	tried            map[string]time.Time
}

// remember notes which server and client ID a connection has now, for
// asking about it after it is gone.
//
// Nothing of nats.go is called under m.mu: nats.go holds its own lock while
// it asks nextLiveServer, which takes the policy lock, never m.mu, and a
// call into nats.go under m.mu would be the other half of a deadlock.
func (m *Managed) remember(l *link, nc *nats.Conn) {
	cid, _ := nc.GetClientID()
	st := nc.Stats()
	serverID, url, now := nc.ConnectedServerId(), nc.ConnectedUrlRedacted(), time.Now()
	m.mu.Lock()
	l.serverID, l.url, l.cid = serverID, url, cid
	l.nc, l.since, l.base, l.samples = nc, now, st, nil
	m.mu.Unlock()
	m.policyMu.Lock()
	l.upSince, l.dropNoted, l.tries, l.failedWhileAPIUp = now, false, 0, 0
	m.policyMu.Unlock()
}

// dropped records a lost connection and what to ask the server about once
// it is back.
func (m *Managed) dropped(l *link, err error) {
	m.mu.Lock()
	nc, base := l.nc, l.base
	m.mu.Unlock()
	var received uint64
	if nc != nil {
		received = nc.Stats().InMsgs - base.InMsgs
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastDrop = &Drop{At: time.Now().UnixMilli(), Reason: err.Error(), Live: l.name == "live"}
	l.pendingServer, l.pendingURL, l.pendingCID = l.serverID, l.url, l.cid
	l.pendingIn, l.pendingDrop = received, m.lastDrop
}

// explainDrop asks the server why it closed the connection it knew as cid,
// and puts the answer on that drop -- and on the last drop shown, when no
// other link dropped since. Reports whether it learnt one.
func (m *Managed) explainDrop(l *link) bool {
	m.mu.Lock()
	serverID, url, cid, received, drop := l.pendingServer, l.pendingURL, l.pendingCID, l.pendingIn, l.pendingDrop
	l.pendingServer, l.pendingURL, l.pendingCID, l.pendingIn, l.pendingDrop = "", "", 0, 0, nil
	m.mu.Unlock()
	if serverID == "" || cid == 0 || drop == nil {
		return false
	}
	closed := m.closedReason(serverID, cid)
	if closed == nil {
		return false
	}
	reason := closed.Reason
	slow := strings.HasPrefix(reason, "Slow Consumer")
	record(m.log, m.Config.Name, Event{Link: l.name, Kind: "reason", Server: url, CID: cid, Detail: closed.describe(received)})
	// Only the explorer's load makes a flap; a shutdown or a restart of
	// the server does not.
	if l.name == "live" && !slow {
		m.notFlap(l)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if slow {
		m.slowConsumerDrops++
	}
	if m.lastDrop == drop {
		m.lastDrop = &Drop{At: drop.At, Reason: reason, Live: drop.Live, SlowConsumer: slow}
	}
	return true
}

// closedConn is what the server remembers of a connection it closed: why,
// and its side of the traffic.
type closedConn struct {
	CID      uint64 `json:"cid"`
	Reason   string `json:"reason"`
	Uptime   string `json:"uptime"`
	RTT      string `json:"rtt"`
	Pending  int64  `json:"pending_bytes"`
	OutMsgs  int64  `json:"out_msgs"`
	OutBytes int64  `json:"out_bytes"`
}

// describe says why the server closed a connection and what it had sent
// over it; the messages it sent that the explorer never read are the ones
// a drop costs.
func (c *closedConn) describe(received uint64) string {
	parts := []string{c.Reason}
	if c.OutMsgs > 0 {
		sent := fmt.Sprintf("the server sent %d msgs, %s", c.OutMsgs, fmtBytes(c.OutBytes))
		if c.Uptime != "" && c.Uptime != "0s" {
			sent += " in " + c.Uptime
		}
		parts = append(parts, sent)
	}
	if c.Pending > 0 {
		parts = append(parts, fmtBytes(c.Pending)+" still queued for the explorer")
	}
	if c.OutMsgs > 0 && received > 0 && uint64(c.OutMsgs) > received {
		parts = append(parts, fmt.Sprintf("≈%d msgs never arrived", uint64(c.OutMsgs)-received))
	}
	if rtt, err := time.ParseDuration(c.RTT); err == nil && rtt > 0 {
		parts = append(parts, "rtt "+fmtDuration(rtt))
	}
	return strings.Join(parts, " · ")
}

// closedConnz is the part of a CONNZ answer the reason is read from.
type closedConnz struct {
	ServerID    string       `json:"server_id"`
	Connections []closedConn `json:"connections"`
}

func (c closedConnz) find(serverID string, cid uint64) *closedConn {
	if c.ServerID != "" && c.ServerID != serverID {
		return nil
	}
	for i := range c.Connections {
		if c.Connections[i].CID == cid && c.Connections[i].Reason != "" {
			return &c.Connections[i]
		}
	}
	return nil
}

// closedReason looks the closed connection up on the server it was on: over
// the system account when there is one, otherwise on the monitoring port.
// Neither is required; without them the reason stays what the client saw.
func (m *Managed) closedReason(serverID string, cid uint64) *closedConn {
	if sys := m.SysNC; sys != nil && sys.IsConnected() {
		req, _ := json.Marshal(map[string]any{"cid": cid, "state": 1})
		if msg, err := sys.Request("$SYS.REQ.SERVER."+serverID+".CONNZ", req, 3*time.Second); err == nil {
			var res struct {
				Data closedConnz `json:"data"`
			}
			if json.Unmarshal(msg.Data, &res) == nil {
				if c := res.Data.find(serverID, cid); c != nil {
					return c
				}
			}
		}
	}
	base, err := MonitoringBase(m.Config)
	if err != nil {
		return nil
	}
	client := &http.Client{Timeout: 3 * time.Second}
	res, err := client.Get(fmt.Sprintf("%s/connz?state=closed&cid=%d", base, cid))
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	var cz closedConnz
	if res.StatusCode != http.StatusOK || json.NewDecoder(res.Body).Decode(&cz) != nil {
		return nil
	}
	return cz.find(serverID, cid)
}
