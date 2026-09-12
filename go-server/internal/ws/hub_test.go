package ws

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"
)

func newTestServer(t *testing.T, hub *Hub) (*httptest.Server, string) {
	t.Helper()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		hub.AddClient(c, r.URL.Query().Get("enc") == "msgpack")
	}))
	t.Cleanup(srv.Close)
	return srv, "ws" + strings.TrimPrefix(srv.URL, "http")
}

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

// A client that disconnects while broadcasts are in flight must never make
// Broadcast panic (the old implementation closed the send channel from the
// reader goroutine).
func TestBroadcastDuringDisconnectDoesNotPanic(t *testing.T) {
	hub := NewHub()
	var disconnects atomic.Int32
	hub.OnDisconnect = func(*Client) { disconnects.Add(1) }
	_, url := newTestServer(t, hub)

	conns := make([]*websocket.Conn, 0, 20)
	for i := 0; i < 20; i++ {
		conns = append(conns, dial(t, url))
	}
	waitFor(t, func() bool { return hub.ClientCount() == 20 })

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				hub.Broadcast(map[string]string{"type": "tick"})
			}
		}
	}()

	for _, c := range conns {
		c.Close()
		time.Sleep(time.Millisecond)
	}
	waitFor(t, func() bool { return hub.ClientCount() == 0 })
	// A client leaves the map before its callback runs -- the map is who is
	// connected, OnDisconnect is what happens afterwards -- so the count
	// reaching zero can beat the last call by a hair, and did about once in
	// fifty runs of the whole suite.
	waitFor(t, func() bool { return disconnects.Load() == 20 })
	close(stop)
	wg.Wait()

	if got := disconnects.Load(); got != 20 {
		t.Fatalf("OnDisconnect called %d times, want 20", got)
	}
}

func TestSendToClientAndOnMessage(t *testing.T) {
	hub := NewHub()
	received := make(chan string, 1)
	hub.OnMessage = func(c *Client, data []byte) {
		received <- string(data)
		hub.SendToClient(c, map[string]string{"type": "echo", "data": string(data)})
	}
	_, url := newTestServer(t, hub)
	c := dial(t, url)
	defer c.Close()

	if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-received:
		if got != `{"type":"hello"}` {
			t.Fatalf("OnMessage got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OnMessage not called")
	}

	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var ev map[string]string
	if err := json.Unmarshal(msg, &ev); err != nil || ev["type"] != "echo" {
		t.Fatalf("unexpected reply %s", msg)
	}
}

func TestSlowClientIsSkippedNotBlocked(t *testing.T) {
	hub := NewHub()
	_, url := newTestServer(t, hub)
	c := dial(t, url)
	defer c.Close()
	waitFor(t, func() bool { return hub.ClientCount() == 1 })

	// Never read on the client side; the send buffer fills up and Broadcast
	// must still return promptly.
	done := make(chan struct{})
	go func() {
		payload := strings.Repeat("x", 1024)
		for i := 0; i < sendBuffer*4; i++ {
			hub.Broadcast(map[string]string{"p": payload})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Broadcast blocked on a slow client")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

type wireMsg struct {
	Subject string `json:"subject"`
	Payload string `json:"payload"`
	Empty   string `json:"empty,omitempty"`
	Size    int    `json:"size"`
}

// A client that asked for MessagePack gets binary frames with the same
// field names as the JSON encoding; both formats coexist in one broadcast.
func TestMsgpackClientsGetBinaryFrames(t *testing.T) {
	hub := NewHub()
	_, url := newTestServer(t, hub)
	jsonC := dial(t, url)
	defer jsonC.Close()
	binC := dial(t, url+"?enc=msgpack")
	defer binC.Close()
	waitFor(t, func() bool { return hub.ClientCount() == 2 })

	hub.Broadcast(map[string]interface{}{"type": "message-batch", "data": []wireMsg{{Subject: "a.b", Payload: "hi", Size: 2}}})

	binC.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, raw, err := binC.ReadMessage()
	if err != nil || mt != websocket.BinaryMessage {
		t.Fatalf("binary client: type %d err %v", mt, err)
	}
	var ev struct {
		Type string    `json:"type"`
		Data []wireMsg `json:"data"`
	}
	dec := msgpack.NewDecoder(bytes.NewReader(raw))
	dec.SetCustomStructTag("json")
	if err := dec.Decode(&ev); err != nil || ev.Type != "message-batch" || len(ev.Data) != 1 || ev.Data[0].Subject != "a.b" || ev.Data[0].Size != 2 {
		t.Fatalf("decoded %+v (%v)", ev, err)
	}
	if bytes.Contains(raw, []byte("empty")) {
		t.Error("omitempty must apply to MessagePack too")
	}

	jsonC.SetReadDeadline(time.Now().Add(2 * time.Second))
	mt, raw, err = jsonC.ReadMessage()
	if err != nil || mt != websocket.TextMessage || !json.Valid(raw) {
		t.Fatalf("json client: type %d valid %v err %v", mt, json.Valid(raw), err)
	}
}
