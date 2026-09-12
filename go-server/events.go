package main

import (
	"nats-explorer/internal/connection"
	"nats-explorer/internal/message"
	"nats-explorer/internal/subscription"
)

// Websocket events sent to the browser. The JSON tags are the wire format
// shared with client/src (shared/src/ws-events.ts); MessagePack uses the same
// names.

// filterErrorEvent answers a view whose CEL expression did not compile, so
// the tab shows the message instead of an empty tree.
type filterErrorEvent struct {
	Type  string `json:"type"`
	Error string `json:"error"`
}

type connectionsEvent struct {
	Type string              `json:"type"`
	Data []connection.Status `json:"data"`
}

type messageBatchEvent struct {
	Type   string                `json:"type"`
	ConnID string                `json:"connId"`
	Data   []message.NatsMessage `json:"data"`
}

type statsEvent struct {
	Type   string             `json:"type"`
	ConnID string             `json:"connId"`
	Data   subscription.Stats `json:"data"`
}

type subjectTreeEvent struct {
	Type    string                      `json:"type"`
	ConnID  string                      `json:"connId"`
	Full    bool                        `json:"full"`
	Data    []subscription.SubjectEntry `json:"data"`
	Removed []string                    `json:"removed"`
}

func connectionsOf(statuses []connection.Status) connectionsEvent {
	return connectionsEvent{Type: "connections", Data: statuses}
}
