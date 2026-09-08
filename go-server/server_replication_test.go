package main

import (
	"context"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// A mirror and a sourcing stream show their relation, their lag and, on the
// origin, who copies from it.
func TestServerStreamReplication(t *testing.T) {
	ns := startNATS(t)
	srv := newTestServer(t, serverConfig{})
	api := &apiClient{t: t, base: srv.URL}
	api.do("POST", "/api/connect", map[string]interface{}{
		"id": "c1", "name": "T", "servers": []string{ns.ClientURL()}, "authMethod": "none",
	}, nil)
	defer api.do("POST", "/api/disconnect-all", nil, nil)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	if _, err := js.CreateStream(ctx, jetstream.StreamConfig{Name: "ORIGIN", Subjects: []string{"rep.>"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := js.CreateStream(ctx, jetstream.StreamConfig{Name: "COPY", Mirror: &jetstream.StreamSource{Name: "ORIGIN"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := js.CreateStream(ctx, jetstream.StreamConfig{Name: "FEED", Sources: []*jetstream.StreamSource{{Name: "ORIGIN"}}}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := js.Publish(ctx, "rep.a", []byte(`{"n":1}`)); err != nil {
			t.Fatal(err)
		}
	}

	type source struct {
		Name   string `json:"name"`
		Lag    uint64 `json:"lag"`
		Active int64  `json:"active"`
	}
	type stream struct {
		Name      string   `json:"name"`
		Subjects  []string `json:"subjects"`
		Mirror    *source  `json:"mirror"`
		Sources   []source `json:"sources"`
		SourcedBy []struct {
			Name string `json:"name"`
			Kind string `json:"kind"`
		} `json:"sourcedBy"`
		State struct {
			Msgs uint64 `json:"messages"`
		} `json:"state"`
	}

	// The copies catch up asynchronously.
	var byName map[string]stream
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var list []stream
		api.do("GET", "/api/streams?connId=c1", nil, &list)
		byName = make(map[string]stream, len(list))
		for _, s := range list {
			byName[s.Name] = s
		}
		if byName["COPY"].State.Msgs == 5 && byName["FEED"].State.Msgs == 5 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	// A mirror carries no subjects of its own; the field must still be a list.
	if byName["COPY"].Subjects == nil {
		t.Error("subjects must be an empty list, not null, or the browser cannot read it")
	}
	if m := byName["COPY"].Mirror; m == nil || m.Name != "ORIGIN" {
		t.Fatalf("COPY mirror = %+v", byName["COPY"].Mirror)
	}
	if lag := byName["COPY"].Mirror.Lag; lag != 0 {
		t.Errorf("a caught-up mirror should have lag 0, got %d", lag)
	}
	if s := byName["FEED"].Sources; len(s) != 1 || s[0].Name != "ORIGIN" {
		t.Fatalf("FEED sources = %+v", s)
	}
	// The origin knows who copies from it, both kinds.
	kinds := map[string]string{}
	for _, u := range byName["ORIGIN"].SourcedBy {
		kinds[u.Name] = u.Kind
	}
	if kinds["COPY"] != "mirror" || kinds["FEED"] != "source" {
		t.Fatalf("ORIGIN sourcedBy = %+v", byName["ORIGIN"].SourcedBy)
	}
	if len(byName["COPY"].SourcedBy) != 0 {
		t.Errorf("a mirror is not sourced by anyone: %+v", byName["COPY"].SourcedBy)
	}
}
