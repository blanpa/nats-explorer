package main

import (
	"fmt"
	"net/url"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
)

// A leaf node connected to a hub shows up in the topology, asked through the
// system account of the hub.
func TestClusterTopologyLeaf(t *testing.T) {
	sysAcc := natsserver.NewAccount("$SYS")
	appAcc := natsserver.NewAccount("APP")
	hubOpts := &natsserver.Options{
		ServerName: "hub", Host: "127.0.0.1", Port: -1, NoLog: true, NoSigs: true,
		Accounts:      []*natsserver.Account{sysAcc, appAcc},
		SystemAccount: "$SYS",
		Users: []*natsserver.User{
			{Username: "sys", Password: "pw", Account: sysAcc},
			{Username: "app", Password: "app", Account: appAcc},
		},
		LeafNode: natsserver.LeafNodeOpts{Host: "127.0.0.1", Port: -1},
	}
	hub, err := natsserver.NewServer(hubOpts)
	if err != nil {
		t.Fatal(err)
	}
	go hub.Start()
	if !hub.ReadyForConnections(5 * time.Second) {
		t.Fatal("hub did not start")
	}
	t.Cleanup(hub.Shutdown)

	remote, _ := url.Parse(fmt.Sprintf("nats://app:app@127.0.0.1:%d", hubOpts.LeafNode.Port))
	leaf, err := natsserver.NewServer(&natsserver.Options{
		ServerName: "edge-leaf", Host: "127.0.0.1", Port: -1, NoLog: true, NoSigs: true,
		LeafNode: natsserver.LeafNodeOpts{Remotes: []*natsserver.RemoteLeafOpts{{URLs: []*url.URL{remote}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	go leaf.Start()
	if !leaf.ReadyForConnections(5 * time.Second) {
		t.Fatal("leaf did not start")
	}
	t.Cleanup(leaf.Shutdown)
	deadline := time.Now().Add(5 * time.Second)
	for hub.NumLeafNodes() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if hub.NumLeafNodes() == 0 {
		t.Fatal("the leaf did not connect")
	}

	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	if st := api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "hub", "servers": []string{hub.ClientURL()}, "authMethod": "userpass", "user": "app", "pass": "app",
		"sysAuthMethod": "userpass", "sysUser": "sys", "sysPass": "pw",
	}, nil); st != 200 {
		t.Fatalf("connect: %d", st)
	}
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	var top struct {
		Source string `json:"source"`
		Nodes  []struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"nodes"`
		Leafs []struct {
			Server  string `json:"server"`
			Name    string `json:"name"`
			Account string `json:"account"`
		} `json:"leafs"`
		Errors []string `json:"errors"`
	}
	if st := api.do("GET", "/api/cluster/c1/topology", nil, &top); st != 200 {
		t.Fatalf("topology: %d", st)
	}
	if top.Source != "system" || len(top.Leafs) != 1 || top.Leafs[0].Server != "hub" || top.Leafs[0].Name != "edge-leaf" || top.Leafs[0].Account != "APP" {
		t.Fatalf("topology = %+v", top)
	}
	kinds := map[string]string{}
	for _, n := range top.Nodes {
		kinds[n.ID] = n.Kind
	}
	if kinds["hub"] != "server" || kinds["edge-leaf"] != "leaf" {
		t.Fatalf("nodes = %+v", top.Nodes)
	}
}
