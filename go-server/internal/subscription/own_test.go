package subscription

import (
	"testing"

	"github.com/nats-io/nats.go"
)

func TestOwnTraffic(t *testing.T) {
	inbox := "_INBOX.abc."
	status := nats.Header{}
	status.Set("Status", "100")
	cases := []struct {
		name string
		msg  nats.Msg
		own  bool
	}{
		{"a consumer's delivery", nats.Msg{Subject: "orders.paid", Reply: "$JS.ACK.ORDERS.c.1.2.3.4.5"}, true},
		{"a reply to the explorer", nats.Msg{Subject: "_INBOX.abc.xyz.1", Data: []byte("{}")}, true},
		{"an API call of the explorer", nats.Msg{Subject: "$JS.API.STREAM.INFO.ORDERS", Reply: "_INBOX.abc.r.1"}, true},
		{"an object chunk the explorer uploads", nats.Msg{Subject: "$O.files.C.n1", Reply: "_INBOX.abc.p.2", Data: []byte("x")}, true},
		{"flow control", nats.Msg{Subject: "_INBOX.other", Header: status}, true},
		{"a request someone else makes", nats.Msg{Subject: "$JS.API.STREAM.INFO.ORDERS", Reply: "_INBOX.other.1"}, false},
		{"a reply to someone else", nats.Msg{Subject: "_INBOX.other.1", Data: []byte("{}")}, false},
		{"a request the explorer sends to a service", nats.Msg{Subject: "pricing.quote", Reply: "_INBOX.abc.r.2"}, false},
		{"a publish", nats.Msg{Subject: "plant.temp", Data: []byte("21")}, false},
		{"a status header with a body", nats.Msg{Subject: "x", Header: status, Data: []byte("1")}, false},
	}
	for _, c := range cases {
		if got := ownTraffic(&c.msg, &inbox); got != c.own {
			t.Errorf("%s: own = %v, want %v", c.name, got, c.own)
		}
	}
	// Without a known prefix only what is unmistakable goes.
	if ownTraffic(&nats.Msg{Subject: "_INBOX.abc.xyz.1"}, nil) {
		t.Error("a reply was dropped without a prefix to tell it by")
	}
}
