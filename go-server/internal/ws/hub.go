package ws

import (
	"bytes"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vmihailenco/msgpack/v5"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 64 * 1024
	sendBuffer     = 512
)

// Client is one connected browser tab.
type Client struct {
	conn *websocket.Conn
	send chan []byte
	done chan struct{}
	once sync.Once
	// binary clients receive MessagePack frames instead of JSON text.
	binary bool
}

// Binary reports whether the client negotiated MessagePack frames.
func (c *Client) Binary() bool { return c.binary }

// Encode serializes an event for the wire: JSON, or MessagePack with the
// same field names (the json struct tags apply) when binary is set.
func Encode(event interface{}, binary bool) ([]byte, error) {
	if !binary {
		return json.Marshal(event)
	}
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	enc.SetCustomStructTag("json")
	if err := enc.Encode(event); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (c *Client) close() {
	c.once.Do(func() { close(c.done) })
}

// Done is closed when the client goes away.
func (c *Client) Done() <-chan struct{} { return c.done }

// Hub fans events out to every connected client. Slow clients are skipped
// rather than blocking the producers.
type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}

	// OnMessage is called for every text frame a client sends.
	OnMessage func(c *Client, data []byte)
	// OnDisconnect is called once when a client is removed.
	OnDisconnect func(c *Client)
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*Client]struct{})}
}

// AddClient registers a websocket connection and starts its reader and writer
// goroutines. The send channel is never closed; the writer exits via done so a
// concurrent Broadcast can never hit a closed channel. binary selects
// MessagePack frames for this client.
func (h *Hub) AddClient(conn *websocket.Conn, binary bool) *Client {
	client := &Client{
		conn:   conn,
		send:   make(chan []byte, sendBuffer),
		done:   make(chan struct{}),
		binary: binary,
	}

	h.mu.Lock()
	h.clients[client] = struct{}{}
	h.mu.Unlock()

	go h.writePump(client)
	go h.readPump(client)

	return client
}

func (h *Hub) remove(client *Client) {
	h.mu.Lock()
	_, present := h.clients[client]
	delete(h.clients, client)
	h.mu.Unlock()
	client.close()
	client.conn.Close()
	if present && h.OnDisconnect != nil {
		h.OnDisconnect(client)
	}
}

func (h *Hub) writePump(client *Client) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		h.remove(client)
	}()
	frame := websocket.TextMessage
	if client.binary {
		frame = websocket.BinaryMessage
	}

	for {
		select {
		case <-client.done:
			return
		case msg := <-client.send:
			client.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := client.conn.WriteMessage(frame, msg); err != nil {
				return
			}
		case <-ticker.C:
			client.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := client.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (h *Hub) readPump(client *Client) {
	defer h.remove(client)

	client.conn.SetReadLimit(maxMessageSize)
	client.conn.SetReadDeadline(time.Now().Add(pongWait))
	client.conn.SetPongHandler(func(string) error {
		client.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		mt, data, err := client.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure, websocket.CloseNoStatusReceived) {
				log.Printf("ws read error: %v", err)
			}
			return
		}
		if mt == websocket.TextMessage && h.OnMessage != nil {
			h.OnMessage(client, data)
		}
	}
}

func (h *Hub) SendToClient(c *Client, event interface{}) {
	data, err := Encode(event, c.binary)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	case <-c.done:
	default:
	}
}

// Broadcast sends an event to every client, encoding it once per format.
func (h *Hub) Broadcast(event interface{}) {
	var encoded [2][]byte
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients {
		i := 0
		if client.binary {
			i = 1
		}
		if encoded[i] == nil {
			data, err := Encode(event, client.binary)
			if err != nil {
				return
			}
			encoded[i] = data
		}
		select {
		case client.send <- encoded[i]:
		case <-client.done:
		default:
			// Buffer full: drop for this client rather than stall everyone.
		}
	}
}

func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
