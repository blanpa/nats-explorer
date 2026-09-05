package connection

import (
	"reflect"
	"testing"
)

func TestNormalizeServers(t *testing.T) {
	got := normalizeServers([]string{" localhost:4222 ", "", "tls://a:1", "nats://b:2", "  "})
	want := []string{"nats://localhost:4222", "tls://a:1", "nats://b:2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestConnectRejectsMissingServers(t *testing.T) {
	s := NewStore()
	if _, err := s.Connect(Config{ID: "x", Servers: []string{" "}}); err == nil {
		t.Fatal("expected an error for empty server list")
	}
}

func TestBuildOptionsValidatesAuth(t *testing.T) {
	m := &Managed{}
	if _, err := buildOptions(Config{AuthMethod: "nkey"}, m, func() {}); err == nil {
		t.Error("nkey without seed must fail")
	}
	if _, err := buildOptions(Config{AuthMethod: "nkey", NKeySeed: "garbage"}, m, func() {}); err == nil {
		t.Error("invalid nkey seed must fail")
	}
	if _, err := buildOptions(Config{AuthMethod: "jwt"}, m, func() {}); err == nil {
		t.Error("jwt without creds must fail")
	}
	if _, err := buildOptions(Config{AuthMethod: "userpass", User: "u", Pass: "p", TLS: true}, m, func() {}); err != nil {
		t.Errorf("userpass+tls should build: %v", err)
	}
}

func TestStatusOfUnknownConnection(t *testing.T) {
	s := NewStore()
	st := s.GetStatus("nope")
	if st.Connected || st.ID != "nope" {
		t.Fatalf("unexpected status %+v", st)
	}
	if _, err := s.GetNC("nope"); err == nil {
		t.Fatal("GetNC must fail for unknown id")
	}
}
