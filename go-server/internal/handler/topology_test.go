package handler

import (
	"encoding/json"
	"testing"
)

func mustJSON[T any](t *testing.T, s string) *T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return &v
}

// Two servers of cluster "hub" route to each other over a pool of
// connections, hub-a has a gateway to cluster "edge" whose server did not
// answer, and hub-b has a leaf node.
func TestBuildTopology(t *testing.T) {
	reports := []serverReport{
		{
			Server: sysServer{Name: "hub-a", ID: "IDA", Cluster: "hub", JetStream: true},
			Routes: mustJSON[routezData](t, `{"routes":[
				{"remote_id":"IDB","remote_name":"hub-b","is_configured":true,"rtt":"1ms","in_msgs":2,"out_msgs":3},
				{"remote_id":"IDB","remote_name":"hub-b","rtt":"1ms","in_msgs":5,"out_msgs":7}]}`),
			Gateways: mustJSON[gatewayzData](t, `{"name":"hub",
				"outbound_gateways":{"edge":{"configured":true,"connection":{"name":"IDE","ip":"10.0.0.9","port":7222,"rtt":"2ms","out_msgs":4}}},
				"inbound_gateways":{"edge":[{"configured":false,"connection":{"name":"IDE","in_msgs":6}}]}}`),
			Leafs: mustJSON[leafzData](t, `{"leafs":[]}`),
		},
		{
			Server: sysServer{Name: "hub-b", ID: "IDB", Cluster: "hub"},
			Routes: mustJSON[routezData](t, `{"routes":[{"remote_id":"IDA","remote_name":"","in_msgs":10,"out_msgs":7}]}`),
			Leafs:  mustJSON[leafzData](t, `{"leafs":[{"name":"leaf-1","account":"APP","ip":"10.0.0.3","port":4000,"rtt":"3ms","in_msgs":1}]}`),
		},
	}
	top := buildTopology(reports)

	kinds := map[string]string{}
	for _, n := range top.Nodes {
		kinds[n.ID] = n.Kind
	}
	// The gateway peer is known by its id only; the leaf by its name.
	want := map[string]string{"hub-a": "server", "hub-b": "server", "IDE": "peer", "leaf-1": "leaf"}
	if len(kinds) != len(want) {
		t.Fatalf("nodes = %+v", top.Nodes)
	}
	for id, k := range want {
		if kinds[id] != k {
			t.Errorf("node %s kind = %q, want %q", id, kinds[id], k)
		}
	}

	// The pool of two connections is one route; the remote id resolves to
	// the name the other server reported.
	if len(top.Routes) != 2 {
		t.Fatalf("routes = %+v", top.Routes)
	}
	a := top.Routes[0]
	if a.Server != "hub-a" || a.Remote != "hub-b" || a.Connections != 2 || a.InMsgs != 7 || a.OutMsgs != 10 || !a.Configured {
		t.Errorf("route hub-a = %+v", a)
	}
	if b := top.Routes[1]; b.Server != "hub-b" || b.Remote != "hub-a" {
		t.Errorf("route hub-b = %+v", b)
	}

	if len(top.Gateways) != 2 || top.Gateways[0].Direction != "outbound" || top.Gateways[0].Address != "10.0.0.9:7222" || top.Gateways[1].InMsgs != 6 {
		t.Errorf("gateways = %+v", top.Gateways)
	}
	if len(top.Leafs) != 1 || top.Leafs[0].Server != "hub-b" || top.Leafs[0].Address != "10.0.0.3:4000" || top.Leafs[0].Account != "APP" {
		t.Errorf("leafs = %+v", top.Leafs)
	}
}

// A gateway that is configured but not connected is still listed, as down.
func TestBuildTopologyGatewayDown(t *testing.T) {
	top := buildTopology([]serverReport{{
		Server:   sysServer{Name: "a", ID: "A", Cluster: "c"},
		Gateways: mustJSON[gatewayzData](t, `{"name":"c","outbound_gateways":{"far":{"configured":true}}}`),
	}})
	if len(top.Gateways) != 1 || top.Gateways[0].Connected || !top.Gateways[0].Configured || top.Gateways[0].Remote != "far" {
		t.Fatalf("gateways = %+v", top.Gateways)
	}
}
