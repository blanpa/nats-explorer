package ws

import (
	"encoding/json"
	"sync"

	"github.com/gorilla/websocket"
)

const maxBufferedAmount = 64 * 1024

type Client struct {
	conn *websocket.Conn
	send chan []byte
}

type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]bool

	OnConnect func(c *Client)
}

func NewHub() *Hub {
	return &Hub{
		clients: make(map[*Client]bool),
	}
}

func (h *Hub) AddClient(conn *websocket.Conn) *Client {
	client := &Client{
		conn: conn,
		send: make(chan []byte, 256),
	}

	h.mu.Lock()
	h.clients[client] = true
	h.mu.Unlock()

	// Writer goroutine
	go func() {
		defer func() {
			conn.Close()
			h.mu.Lock()
			delete(h.clients, client)
			h.mu.Unlock()
		}()
		for msg := range client.send {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		}
	}()

	// Reader goroutine (just drain incoming messages)
	go func() {
		defer func() {
			close(client.send)
		}()
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				return
			}
		}
	}()

	if h.OnConnect != nil {
		h.OnConnect(client)
	}

	return client
}

func (h *Hub) SendToClient(c *Client, event interface{}) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	select {
	case c.send <- data:
	default:
		// Buffer full, skip
	}
}

func (h *Hub) Broadcast(event interface{}) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients {
		select {
		case client.send <- data:
		default:
			// Skip slow clients
		}
	}
}

func (h *Hub) BroadcastRaw(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients {
		select {
		case client.send <- data:
		default:
		}
	}
}

func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
