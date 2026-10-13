package handler

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/nats-io/nats.go"

	"nats-explorer/internal/connection"
)

// The topology is who is connected to whom: the routes inside a cluster, the
// gateways between clusters and the leaf nodes hanging off a server. Every
// server describes its own side of each connection (routez, gatewayz,
// leafz); the system account asks all of them at once, the monitoring port
// only the one the explorer is connected to.

type routezData struct {
	Routes []struct {
		RemoteID     string `json:"remote_id"`
		RemoteName   string `json:"remote_name"`
		DidSolicit   bool   `json:"did_solicit"`
		IsConfigured bool   `json:"is_configured"`
		IP           string `json:"ip"`
		Port         int    `json:"port"`
		RTT          string `json:"rtt"`
		Pending      int64  `json:"pending_size"`
		InMsgs       int64  `json:"in_msgs"`
		OutMsgs      int64  `json:"out_msgs"`
		InBytes      int64  `json:"in_bytes"`
		OutBytes     int64  `json:"out_bytes"`
		Subs         int    `json:"subscriptions"`
		Compression  string `json:"compression"`
	} `json:"routes"`
}

type gatewayConn struct {
	Configured bool `json:"configured"`
	Connection *struct {
		Name     string `json:"name"` // the remote server's id
		IP       string `json:"ip"`
		Port     int    `json:"port"`
		RTT      string `json:"rtt"`
		Uptime   string `json:"uptime"`
		Idle     string `json:"idle"`
		Pending  int64  `json:"pending_bytes"`
		InMsgs   int64  `json:"in_msgs"`
		OutMsgs  int64  `json:"out_msgs"`
		InBytes  int64  `json:"in_bytes"`
		OutBytes int64  `json:"out_bytes"`
		Subs     int    `json:"subscriptions"`
	} `json:"connection"`
}

type gatewayzData struct {
	Name     string                   `json:"name"`
	Outbound map[string]gatewayConn   `json:"outbound_gateways"`
	Inbound  map[string][]gatewayConn `json:"inbound_gateways"`
}

type leafzData struct {
	Leafs []struct {
		Name        string `json:"name"`
		IsSpoke     bool   `json:"is_spoke"`
		Account     string `json:"account"`
		IP          string `json:"ip"`
		Port        int    `json:"port"`
		RTT         string `json:"rtt"`
		InMsgs      int64  `json:"in_msgs"`
		OutMsgs     int64  `json:"out_msgs"`
		InBytes     int64  `json:"in_bytes"`
		OutBytes    int64  `json:"out_bytes"`
		Subs        int    `json:"subscriptions"`
		Compression string `json:"compression"`
	} `json:"leafs"`
}

// serverReport is what one server said about itself and its connections.
type serverReport struct {
	Server   sysServer
	Routes   *routezData
	Gateways *gatewayzData
	Leafs    *leafzData
}

type topoNode struct {
	// ID is the key links refer to: the server name where one is known.
	ID      string `json:"id"`
	Name    string `json:"name"`
	Cluster string `json:"cluster,omitempty"`
	// Kind is "server" for a server that answered, "peer" for a route or
	// gateway peer that did not (it is only known from the other side), and
	// "leaf" for a leaf node.
	Kind      string `json:"kind"`
	Version   string `json:"version,omitempty"`
	JetStream bool   `json:"jetstream,omitempty"`
	Account   string `json:"account,omitempty"`
}

type topoTraffic struct {
	InMsgs   int64 `json:"inMsgs"`
	OutMsgs  int64 `json:"outMsgs"`
	InBytes  int64 `json:"inBytes"`
	OutBytes int64 `json:"outBytes"`
}

type topoRoute struct {
	Server      string `json:"server"`
	Remote      string `json:"remote"`
	Connections int    `json:"connections"`
	RTT         string `json:"rtt"`
	Pending     int64  `json:"pending"`
	Subs        int    `json:"subscriptions"`
	Configured  bool   `json:"configured"`
	Compression string `json:"compression,omitempty"`
	topoTraffic
}

type topoGateway struct {
	Server string `json:"server"`
	// Cluster is the gateway name of the reporting server, Remote that of
	// the other side.
	Cluster      string `json:"cluster"`
	Remote       string `json:"remote"`
	Direction    string `json:"direction"` // "outbound" | "inbound"
	Configured   bool   `json:"configured"`
	Connected    bool   `json:"connected"`
	RemoteServer string `json:"remoteServer,omitempty"`
	Address      string `json:"address,omitempty"`
	RTT          string `json:"rtt,omitempty"`
	Uptime       string `json:"uptime,omitempty"`
	Idle         string `json:"idle,omitempty"`
	Pending      int64  `json:"pending"`
	Subs         int    `json:"subscriptions"`
	topoTraffic
}

type topoLeaf struct {
	Server      string `json:"server"`
	Name        string `json:"name"`
	Account     string `json:"account"`
	Address     string `json:"address"`
	RTT         string `json:"rtt"`
	Spoke       bool   `json:"spoke"`
	Subs        int    `json:"subscriptions"`
	Compression string `json:"compression,omitempty"`
	topoTraffic
}

type topology struct {
	Source   string        `json:"source"`
	Nodes    []topoNode    `json:"nodes"`
	Routes   []topoRoute   `json:"routes"`
	Gateways []topoGateway `json:"gateways"`
	Leafs    []topoLeaf    `json:"leafs"`
	Errors   []string      `json:"errors"`
}

// buildTopology merges what the servers reported into one picture. A route
// is reported by both of its ends and a gateway by both clusters; each side
// is kept, because the two sides count different directions and one of them
// can be missing.
func buildTopology(reports []serverReport) topology {
	out := topology{Nodes: []topoNode{}, Routes: []topoRoute{}, Gateways: []topoGateway{}, Leafs: []topoLeaf{}, Errors: []string{}}
	nameOf := map[string]string{} // server id -> name
	nodes := map[string]*topoNode{}
	addNode := func(n topoNode) {
		if old, ok := nodes[n.ID]; ok {
			// What a server says about itself beats what others say about it.
			if old.Kind != "server" && n.Kind == "server" {
				*old = n
			}
			if old.Cluster == "" {
				old.Cluster = n.Cluster
			}
			return
		}
		nodes[n.ID] = &n
	}
	for _, r := range reports {
		nameOf[r.Server.ID] = r.Server.Name
		addNode(topoNode{ID: r.Server.Name, Name: r.Server.Name, Cluster: r.Server.Cluster, Kind: "server", Version: r.Server.Version, JetStream: r.Server.JetStream})
	}
	for _, r := range reports {
		if r.Routes != nil {
			byRemote := map[string]*topoRoute{}
			for _, rt := range r.Routes.Routes {
				remote := rt.RemoteName
				if remote == "" {
					remote = nameOrID(nameOf, rt.RemoteID)
				}
				addNode(topoNode{ID: remote, Name: remote, Cluster: r.Server.Cluster, Kind: "peer"})
				agg, ok := byRemote[remote]
				if !ok {
					agg = &topoRoute{Server: r.Server.Name, Remote: remote, RTT: rt.RTT, Compression: rt.Compression}
					byRemote[remote] = agg
				}
				// A route can be a pool of connections, plus one per pinned
				// account; they are one link between two servers.
				agg.Connections++
				agg.Configured = agg.Configured || rt.IsConfigured
				agg.Pending += rt.Pending
				agg.Subs += rt.Subs
				agg.InMsgs += rt.InMsgs
				agg.OutMsgs += rt.OutMsgs
				agg.InBytes += rt.InBytes
				agg.OutBytes += rt.OutBytes
			}
			for _, agg := range byRemote {
				out.Routes = append(out.Routes, *agg)
			}
		}
		if r.Gateways != nil {
			add := func(remote, direction string, gc gatewayConn) {
				g := topoGateway{Server: r.Server.Name, Cluster: r.Gateways.Name, Remote: remote, Direction: direction, Configured: gc.Configured}
				if c := gc.Connection; c != nil {
					g.Connected = true
					g.RemoteServer = nameOrID(nameOf, c.Name)
					g.Address = hostPort(c.IP, c.Port)
					g.RTT, g.Uptime, g.Idle = c.RTT, c.Uptime, c.Idle
					g.Pending, g.Subs = c.Pending, c.Subs
					g.topoTraffic = topoTraffic{InMsgs: c.InMsgs, OutMsgs: c.OutMsgs, InBytes: c.InBytes, OutBytes: c.OutBytes}
					addNode(topoNode{ID: g.RemoteServer, Name: g.RemoteServer, Cluster: remote, Kind: "peer"})
				}
				out.Gateways = append(out.Gateways, g)
			}
			for remote, gc := range r.Gateways.Outbound {
				add(remote, "outbound", gc)
			}
			for remote, list := range r.Gateways.Inbound {
				for _, gc := range list {
					add(remote, "inbound", gc)
				}
			}
		}
		if r.Leafs != nil {
			for _, l := range r.Leafs.Leafs {
				name := l.Name
				if name == "" {
					name = hostPort(l.IP, l.Port)
				}
				out.Leafs = append(out.Leafs, topoLeaf{
					Server: r.Server.Name, Name: name, Account: l.Account, Address: hostPort(l.IP, l.Port), RTT: l.RTT, Spoke: l.IsSpoke,
					Subs: l.Subs, Compression: l.Compression,
					topoTraffic: topoTraffic{InMsgs: l.InMsgs, OutMsgs: l.OutMsgs, InBytes: l.InBytes, OutBytes: l.OutBytes},
				})
				// A leaf that is itself a server of the system answered for
				// itself; otherwise it is known only from this side.
				addNode(topoNode{ID: name, Name: name, Kind: "leaf", Account: l.Account})
			}
		}
	}
	for _, n := range nodes {
		out.Nodes = append(out.Nodes, *n)
	}
	sort.Slice(out.Nodes, func(i, j int) bool {
		if out.Nodes[i].Cluster != out.Nodes[j].Cluster {
			return out.Nodes[i].Cluster < out.Nodes[j].Cluster
		}
		return out.Nodes[i].ID < out.Nodes[j].ID
	})
	sort.Slice(out.Routes, func(i, j int) bool {
		if out.Routes[i].Server != out.Routes[j].Server {
			return out.Routes[i].Server < out.Routes[j].Server
		}
		return out.Routes[i].Remote < out.Routes[j].Remote
	})
	sort.SliceStable(out.Gateways, func(i, j int) bool {
		a, b := out.Gateways[i], out.Gateways[j]
		if a.Server != b.Server {
			return a.Server < b.Server
		}
		if a.Remote != b.Remote {
			return a.Remote < b.Remote
		}
		return a.Direction > b.Direction // outbound first
	})
	sort.Slice(out.Leafs, func(i, j int) bool {
		if out.Leafs[i].Server != out.Leafs[j].Server {
			return out.Leafs[i].Server < out.Leafs[j].Server
		}
		return out.Leafs[i].Name < out.Leafs[j].Name
	})
	return out
}

func nameOrID(nameOf map[string]string, id string) string {
	if n, ok := nameOf[id]; ok {
		return n
	}
	return id
}

func hostPort(ip string, port int) string {
	if ip == "" {
		return ""
	}
	if port == 0 {
		return ip
	}
	return ip + ":" + strconv.Itoa(port)
}

// Topology answers GET /api/cluster/{connId}/topology.
func (h *ClusterHandler) Topology(w http.ResponseWriter, r *http.Request) {
	managed, ok := h.Store.Get(urlParam(r, "connId"))
	if !ok {
		writeError(w, http.StatusNotFound, "connection not found")
		return
	}
	var reports []serverReport
	var errs []string
	source := "monitoring"
	if managed.SysNC != nil && managed.SysNC.IsConnected() {
		source = "system"
		reports, errs = topologyViaSystem(managed.SysNC)
	} else {
		if managed.SysError != "" {
			errs = append(errs, "system account: "+managed.SysError)
		}
		rep, err := topologyViaMonitoring(managed.Config)
		if err != nil {
			errs = append(errs, err.Error())
		} else {
			reports = []serverReport{rep}
			errs = append(errs, "only the connected server is asked: add system-account credentials to the connection to see every server's side")
		}
	}
	out := buildTopology(reports)
	out.Source = source
	out.Errors = append(out.Errors, errs...)
	writeJSON(w, out)
}

// topologyViaSystem asks every server for its routes, gateways and leaf
// nodes, one ping each, and pairs the answers up by server.
func topologyViaSystem(nc *nats.Conn) ([]serverReport, []string) {
	var errs []string
	byID := map[string]*serverReport{}
	var order []string
	collect := func(kind string, set func(*serverReport, json.RawMessage) error) {
		replies, err := pingAll(nc, kind, nil)
		if err != nil {
			errs = append(errs, kind+": "+err.Error())
			return
		}
		for _, raw := range replies {
			var m struct {
				Server sysServer       `json:"server"`
				Data   json.RawMessage `json:"data"`
			}
			if json.Unmarshal(raw, &m) != nil || m.Server.ID == "" {
				continue
			}
			rep, ok := byID[m.Server.ID]
			if !ok {
				rep = &serverReport{Server: m.Server}
				byID[m.Server.ID] = rep
				order = append(order, m.Server.ID)
			}
			if err := set(rep, m.Data); err != nil {
				errs = append(errs, kind+" from "+m.Server.Name+": "+err.Error())
			}
		}
	}
	collect("ROUTEZ", func(rep *serverReport, d json.RawMessage) error {
		rep.Routes = &routezData{}
		return json.Unmarshal(d, rep.Routes)
	})
	collect("GATEWAYZ", func(rep *serverReport, d json.RawMessage) error {
		rep.Gateways = &gatewayzData{}
		return json.Unmarshal(d, rep.Gateways)
	})
	collect("LEAFZ", func(rep *serverReport, d json.RawMessage) error {
		rep.Leafs = &leafzData{}
		return json.Unmarshal(d, rep.Leafs)
	})
	if len(order) == 0 && len(errs) == 0 {
		errs = append(errs, "no server answered the system pings: the system-account user probably lacks permission")
	}
	out := make([]serverReport, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, errs
}

func topologyViaMonitoring(cfg connection.Config) (serverReport, error) {
	base, err := monitoringBaseURL(cfg)
	if err != nil {
		return serverReport{}, err
	}
	client := &http.Client{Timeout: 5 * time.Second}
	var varz struct {
		Name    string `json:"server_name"`
		ID      string `json:"server_id"`
		Host    string `json:"host"`
		Version string `json:"version"`
		Cluster struct {
			Name string `json:"name"`
		} `json:"cluster"`
		JetStream any `json:"jetstream"`
	}
	if err := fetchJSON(client, base+"/varz", &varz); err != nil {
		return serverReport{}, err
	}
	rep := serverReport{Server: sysServer{Name: varz.Name, ID: varz.ID, Host: varz.Host, Version: varz.Version, Cluster: varz.Cluster.Name, JetStream: varz.JetStream != nil}}
	var routes routezData
	if fetchJSON(client, base+"/routez", &routes) == nil {
		rep.Routes = &routes
	}
	var gws gatewayzData
	if fetchJSON(client, base+"/gatewayz", &gws) == nil {
		rep.Gateways = &gws
	}
	var leafs leafzData
	if fetchJSON(client, base+"/leafz", &leafs) == nil {
		rep.Leafs = &leafs
	}
	return rep, nil
}
