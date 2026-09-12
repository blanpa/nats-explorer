package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/connection"
)

// ClusterHandler builds a cluster-wide view. With a system-account connection
// it asks every server ($SYS.REQ.SERVER.PING.STATSZ / JSZ); without one it
// falls back to the HTTP monitoring endpoint of the connected server only.
type ClusterHandler struct {
	Store *connection.Store
}

const (
	pingHardLimit = 2 * time.Second
	pingQuiet     = 300 * time.Millisecond
)

// wire structures (fields we read; the rest is passed through where useful)

type sysServer struct {
	Name      string `json:"name"`
	Host      string `json:"host"`
	ID        string `json:"id"`
	Cluster   string `json:"cluster"`
	Version   string `json:"ver"`
	JetStream bool   `json:"jetstream"`
	Time      string `json:"time"`
}

type counter struct {
	Msgs  int64 `json:"msgs"`
	Bytes int64 `json:"bytes"`
}

type metaCluster struct {
	Name     string     `json:"name"`
	Leader   string     `json:"leader"`
	Size     int        `json:"cluster_size"`
	Replicas []peerInfo `json:"replicas"`
}

type peerInfo struct {
	Name    string `json:"name"`
	Current bool   `json:"current"`
	Offline bool   `json:"offline"`
	Active  int64  `json:"active"`
	Lag     int64  `json:"lag"`
}

type jsStats struct {
	Memory    int64 `json:"memory"`
	Storage   int64 `json:"storage"`
	Streams   int   `json:"streams"`
	Consumers int   `json:"consumers"`
	API       struct {
		Total  int64 `json:"total"`
		Errors int64 `json:"errors"`
	} `json:"api"`
}

type statszMsg struct {
	Server sysServer `json:"server"`
	Stats  struct {
		Start            string    `json:"start"`
		Mem              int64     `json:"mem"`
		Cores            int       `json:"cores"`
		CPU              float64   `json:"cpu"`
		Connections      int       `json:"connections"`
		TotalConnections int64     `json:"total_connections"`
		ActiveAccounts   int       `json:"active_accounts"`
		Subscriptions    int       `json:"subscriptions"`
		Sent             counter   `json:"sent"`
		Received         counter   `json:"received"`
		SlowConsumers    int64     `json:"slow_consumers"`
		Routes           []any     `json:"routes"`
		Gateways         []any     `json:"gateways"`
		ActiveServers    int       `json:"active_servers"`
		JetStream        *struct { // JetStreamVarz
			Stats *jsStats     `json:"stats"`
			Meta  *metaCluster `json:"meta"`
		} `json:"jetstream"`
	} `json:"statsz"`
}

// jszData is the body of /jsz and of the JSZ ping reply.
type jszData struct {
	jsStats
	Messages       int64        `json:"messages"`
	Bytes          int64        `json:"bytes"`
	MetaCluster    *metaCluster `json:"meta_cluster"`
	AccountDetails []struct {
		Name         string `json:"name"`
		StreamDetail []struct {
			Name    string `json:"name"`
			Created string `json:"created"`
			Cluster *struct {
				Name     string     `json:"name"`
				Leader   string     `json:"leader"`
				Replicas []peerInfo `json:"replicas"`
			} `json:"cluster"`
			State struct {
				Messages  int64 `json:"messages"`
				Bytes     int64 `json:"bytes"`
				Consumers int   `json:"consumer_count"`
			} `json:"state"`
			Config struct {
				Replicas int    `json:"num_replicas"`
				Storage  string `json:"storage"`
			} `json:"config"`
		} `json:"stream_detail"`
	} `json:"account_details"`
}

type jszMsg struct {
	Server sysServer `json:"server"`
	Data   jszData   `json:"data"`
}

// response shapes

type clusterServer struct {
	Name          string   `json:"name"`
	ID            string   `json:"id"`
	Host          string   `json:"host"`
	Version       string   `json:"version"`
	Cluster       string   `json:"cluster"`
	JetStream     bool     `json:"jetstream"`
	MetaLeader    bool     `json:"metaLeader"`
	Start         string   `json:"start,omitempty"`
	CPU           float64  `json:"cpu"`
	Cores         int      `json:"cores"`
	Mem           int64    `json:"mem"`
	Connections   int      `json:"connections"`
	Subscriptions int      `json:"subscriptions"`
	SlowConsumers int64    `json:"slowConsumers"`
	InMsgs        int64    `json:"inMsgs"`
	OutMsgs       int64    `json:"outMsgs"`
	InBytes       int64    `json:"inBytes"`
	OutBytes      int64    `json:"outBytes"`
	Routes        int      `json:"routes"`
	Gateways      int      `json:"gateways"`
	JS            *jsStats `json:"js,omitempty"`
}

type clusterStream struct {
	Account   string     `json:"account"`
	Name      string     `json:"name"`
	Messages  int64      `json:"messages"`
	Bytes     int64      `json:"bytes"`
	Consumers int        `json:"consumers"`
	Replicas  int        `json:"replicas"`
	Storage   string     `json:"storage"`
	Cluster   string     `json:"cluster,omitempty"`
	Leader    string     `json:"leader,omitempty"`
	Peers     []peerInfo `json:"peers"`
	Created   string     `json:"created,omitempty"`
	_         struct{}   `json:"-"`
}

type clusterOverview struct {
	Source  string          `json:"source"` // "system" | "monitoring"
	Servers []clusterServer `json:"servers"`
	Meta    *metaCluster    `json:"meta"`
	Streams []clusterStream `json:"streams"`
	Errors  []string        `json:"errors"`
}

// pingAll sends one system request and collects every reply until the
// servers go quiet for pingQuiet or pingHardLimit passes.
func pingAll(nc *nats.Conn, kind string, body []byte) ([][]byte, error) {
	inbox := nats.NewInbox()
	sub, err := nc.SubscribeSync(inbox)
	if err != nil {
		return nil, err
	}
	defer sub.Unsubscribe()
	if err := nc.PublishRequest("$SYS.REQ.SERVER.PING."+kind, inbox, body); err != nil {
		return nil, err
	}
	hard := time.Now().Add(pingHardLimit)
	deadline := hard
	var out [][]byte
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return out, nil
		}
		msg, err := sub.NextMsg(remaining)
		if err != nil {
			return out, nil
		}
		out = append(out, msg.Data)
		if quiet := time.Now().Add(pingQuiet); quiet.Before(hard) {
			deadline = quiet
		}
	}
}

func (h *ClusterHandler) Overview(w http.ResponseWriter, r *http.Request) {
	managed, ok := h.Store.Get(urlParam(r, "connId"))
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	out := clusterOverview{Servers: []clusterServer{}, Streams: []clusterStream{}, Errors: []string{}}
	if managed.SysNC != nil && managed.SysNC.IsConnected() {
		out.Source = "system"
		h.viaSystem(managed.SysNC, &out)
	} else {
		out.Source = "monitoring"
		if managed.SysError != "" {
			out.Errors = append(out.Errors, "system account: "+managed.SysError)
		}
		h.viaMonitoring(managed.Config, &out)
	}
	if out.Meta != nil && out.Meta.Replicas == nil {
		out.Meta.Replicas = []peerInfo{}
	}
	sort.Slice(out.Servers, func(i, j int) bool { return out.Servers[i].Name < out.Servers[j].Name })
	sort.Slice(out.Streams, func(i, j int) bool {
		if out.Streams[i].Account != out.Streams[j].Account {
			return out.Streams[i].Account < out.Streams[j].Account
		}
		return out.Streams[i].Name < out.Streams[j].Name
	})
	writeJSON(w, out)
}

func (h *ClusterHandler) viaSystem(nc *nats.Conn, out *clusterOverview) {
	replies, err := pingAll(nc, "STATSZ", nil)
	if err != nil {
		out.Errors = append(out.Errors, "STATSZ: "+err.Error())
		return
	}
	if len(replies) == 0 {
		out.Errors = append(out.Errors, "no server answered $SYS.REQ.SERVER.PING.STATSZ: the system-account user probably lacks permission")
		return
	}
	var leader string
	for _, raw := range replies {
		var m statszMsg
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		srv := clusterServer{
			Name: m.Server.Name, ID: m.Server.ID, Host: m.Server.Host, Version: m.Server.Version, Cluster: m.Server.Cluster, JetStream: m.Server.JetStream,
			Start: m.Stats.Start, CPU: m.Stats.CPU, Cores: m.Stats.Cores, Mem: m.Stats.Mem, Connections: m.Stats.Connections, Subscriptions: m.Stats.Subscriptions,
			SlowConsumers: m.Stats.SlowConsumers, InMsgs: m.Stats.Received.Msgs, OutMsgs: m.Stats.Sent.Msgs, InBytes: m.Stats.Received.Bytes, OutBytes: m.Stats.Sent.Bytes,
			Routes: len(m.Stats.Routes), Gateways: len(m.Stats.Gateways),
		}
		if m.Stats.JetStream != nil {
			srv.JS = m.Stats.JetStream.Stats
			if m.Stats.JetStream.Meta != nil && out.Meta == nil {
				meta := *m.Stats.JetStream.Meta
				out.Meta = &meta
				leader = meta.Leader
			}
		}
		out.Servers = append(out.Servers, srv)
	}
	for i := range out.Servers {
		out.Servers[i].MetaLeader = leader != "" && out.Servers[i].Name == leader
	}

	// Stream placement: every JetStream node reports the streams it holds; merge by account/name.
	body, _ := json.Marshal(map[string]any{"accounts": true, "streams": true, "config": true})
	jszReplies, err := pingAll(nc, "JSZ", body)
	if err != nil {
		out.Errors = append(out.Errors, "JSZ: "+err.Error())
		return
	}
	seen := map[string]int{}
	for _, raw := range jszReplies {
		var m jszMsg
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		if m.Data.MetaCluster != nil && (out.Meta == nil || len(out.Meta.Replicas) == 0) {
			meta := *m.Data.MetaCluster
			out.Meta = &meta
		}
		// JSZ carries the per-node JetStream usage; STATSZ only has the system account's view.
		for i := range out.Servers {
			if out.Servers[i].Name == m.Server.Name {
				js := m.Data.jsStats
				out.Servers[i].JS = &js
			}
		}
		fromLeader := leader == "" || m.Server.Name == leader
		for _, s := range streamsOf(m.Data) {
			key := s.Account + "/" + s.Name
			if idx, ok := seen[key]; ok {
				if fromLeader {
					out.Streams[idx] = s
				}
				continue
			}
			seen[key] = len(out.Streams)
			out.Streams = append(out.Streams, s)
		}
	}
}

func (h *ClusterHandler) viaMonitoring(cfg connection.Config, out *clusterOverview) {
	base, err := monitoringBaseURL(cfg)
	if err != nil {
		out.Errors = append(out.Errors, err.Error())
		return
	}
	client := &http.Client{Timeout: 5 * time.Second}
	var varz struct {
		Host    string `json:"host"`
		Cluster struct {
			Name string `json:"name"`
		} `json:"cluster"`
		Name             string  `json:"server_name"`
		ID               string  `json:"server_id"`
		Version          string  `json:"version"`
		Start            string  `json:"start"`
		Mem              int64   `json:"mem"`
		Cores            int     `json:"cores"`
		CPU              float64 `json:"cpu"`
		Connections      int     `json:"connections"`
		Subscriptions    int     `json:"subscriptions"`
		SlowConsumers    int64   `json:"slow_consumers"`
		InMsgs, OutMsgs  int64
		InBytes          int64 `json:"in_bytes"`
		OutBytes         int64 `json:"out_bytes"`
		InMsgsJSON       int64 `json:"in_msgs"`
		OutMsgsJSON      int64 `json:"out_msgs"`
		Routes           int   `json:"routes"`
		Gateways         int   `json:"gateways"`
		JetStreamPresent any   `json:"jetstream"`
	}
	if err := fetchJSON(client, base+"/varz", &varz); err != nil {
		out.Errors = append(out.Errors, "varz: "+err.Error())
		return
	}
	srv := clusterServer{
		Name: varz.Name, ID: varz.ID, Host: varz.Host, Version: varz.Version, Cluster: varz.Cluster.Name, JetStream: varz.JetStreamPresent != nil,
		Start: varz.Start, CPU: varz.CPU, Cores: varz.Cores, Mem: varz.Mem, Connections: varz.Connections, Subscriptions: varz.Subscriptions,
		SlowConsumers: varz.SlowConsumers, InMsgs: varz.InMsgsJSON, OutMsgs: varz.OutMsgsJSON, InBytes: varz.InBytes, OutBytes: varz.OutBytes,
		Routes: varz.Routes, Gateways: varz.Gateways,
	}
	var jsz jszData
	if err := fetchJSON(client, base+"/jsz?accounts=true&streams=true&config=true", &jsz); err == nil {
		srv.JS = &jsz.jsStats
		if jsz.MetaCluster != nil {
			meta := *jsz.MetaCluster
			out.Meta = &meta
			srv.MetaLeader = meta.Leader == srv.Name
		}
		out.Streams = append(out.Streams, streamsOf(jsz)...)
	} else {
		out.Errors = append(out.Errors, "jsz: "+err.Error())
	}
	out.Servers = append(out.Servers, srv)
	if srv.Cluster != "" {
		out.Errors = append(out.Errors, fmt.Sprintf("only %s is visible: add system-account credentials to the connection to see every node of cluster %s", srv.Name, srv.Cluster))
	}
}

func streamsOf(d jszData) []clusterStream {
	var out []clusterStream
	for _, acc := range d.AccountDetails {
		for _, sd := range acc.StreamDetail {
			s := clusterStream{Account: acc.Name, Name: sd.Name, Messages: sd.State.Messages, Bytes: sd.State.Bytes, Consumers: sd.State.Consumers, Replicas: sd.Config.Replicas, Storage: strings.ToLower(sd.Config.Storage), Created: sd.Created, Peers: []peerInfo{}}
			if sd.Cluster != nil {
				s.Cluster = sd.Cluster.Name
				s.Leader = sd.Cluster.Leader
				if sd.Cluster.Replicas != nil {
					s.Peers = sd.Cluster.Replicas
				}
			}
			out = append(out, s)
		}
	}
	return out
}

func fetchJSON(client *http.Client, url string, v any) error {
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}
