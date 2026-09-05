package subscription

import (
	"encoding/base64"
	"testing"
)

func TestEncodePayload(t *testing.T) {
	cases := []struct {
		name     string
		in       []byte
		wantType string
		wantOut  string
	}{
		{"json object", []byte(`{"a":1}`), "json", `{"a":1}`},
		{"json array", []byte(`[1,2]`), "json", `[1,2]`},
		{"looks like json but invalid", []byte(`{oops`), "string", `{oops`},
		{"plain text", []byte("hello"), "string", "hello"},
		{"empty", []byte(""), "string", ""},
		{"utf8 text", []byte("grüße"), "string", "grüße"},
		{"binary", []byte{0xff, 0x00, 0x01}, "binary", base64.StdEncoding.EncodeToString([]byte{0xff, 0x00, 0x01})},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, typ := EncodePayload(c.in)
			if typ != c.wantType {
				t.Errorf("type = %q, want %q", typ, c.wantType)
			}
			if out != c.wantOut {
				t.Errorf("payload = %q, want %q", out, c.wantOut)
			}
		})
	}
}

func TestManagerStopIsIdempotent(t *testing.T) {
	m := NewManager("c1")
	m.Stop() // never started
	m.Stop()
	if m.GetStats().Received != 0 {
		t.Fatal("fresh manager must have no stats")
	}
}
