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

func TestAdmitBudgets(t *testing.T) {
	m := NewManager("c1")
	m.SetFocus("tab", "hot.branch")

	// Focused subjects ignore the background budget but keep the per-subject cap.
	got := 0
	for i := 0; i < MaxMsgsPerSecondPerSubject+5; i++ {
		if m.admit("hot.branch.leaf") {
			got++
		}
	}
	if got != MaxMsgsPerSecondPerSubject {
		t.Fatalf("focused subject admitted %d, want %d", got, MaxMsgsPerSecondPerSubject)
	}
	if m.admit("hot.branchx") {
		// "hot.branchx" is not below "hot.branch"; it counts as background.
	}
	if m.bgSent != 1 {
		t.Fatalf("prefix match must respect segment boundaries, bgSent=%d", m.bgSent)
	}

	// Background: first message per subject wins over repeats once half the budget is used.
	m.emitCounts = map[string]int{}
	m.bgSent = 0
	for i := 0; i < MaxBackgroundMsgsPerSecond/2; i++ {
		m.admit("bg.repeat")
		m.emitCounts["bg.repeat"] = 1 // keep it below the per-subject cap
	}
	if m.admit("bg.repeat") {
		t.Fatal("repeat message must be refused above half the background budget")
	}
	if !m.admit("bg.fresh") {
		t.Fatal("first message of a subject must still get through")
	}
	m.bgSent = MaxBackgroundMsgsPerSecond
	if m.admit("bg.other") {
		t.Fatal("background budget exhausted must drop")
	}
	if !m.admit("hot.branch") {
		t.Fatal("focused subject itself must get through")
	}

	m.ClearFocus("tab")
	if m.isFocused("hot.branch.leaf") {
		t.Fatal("focus should be cleared")
	}
}
