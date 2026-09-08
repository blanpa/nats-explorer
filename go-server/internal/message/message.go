// Package message holds a received NATS message and its wire form for the
// browser. It sits below the subscription manager and the history store so
// both can share it without importing each other.
package message

import (
	"encoding/base64"
	"encoding/json"
	"hash/maphash"
	"sync/atomic"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
)

// NatsMessage is the wire format sent to the browser. Binary payloads are
// base64 encoded and flagged with PayloadType "binary".
type NatsMessage struct {
	Subject     string              `json:"subject"`
	Payload     string              `json:"payload"`
	PayloadType string              `json:"payloadType"` // "string", "json", "binary"
	Headers     map[string][]string `json:"headers,omitempty"`
	Timestamp   int64               `json:"timestamp"`
	Reply       string              `json:"reply,omitempty"`
	Size        int                 `json:"size"`
	// Sequence is the arrival number of the message on its connection. It is
	// unique per connection and lets the browser merge the live feed with
	// history pulled over REST without relying on millisecond timestamps.
	Sequence uint64 `json:"sequence,omitempty"`
	// ConnID is set on messages served from history, where one response may
	// span several connections. The live feed carries it on the envelope.
	ConnID string `json:"connId,omitempty"`
}

// Record is a received message as the server keeps it: the payload bytes
// as delivered by nats.go (which hands out a fresh slice per message), no
// copy, no classification. The wire form is produced on demand, so the
// hundreds of thousands of messages per second that nobody looks at cost
// no more than a struct.
type Record struct {
	Subject   string
	Data      []byte
	Header    nats.Header
	Reply     string
	Timestamp int64
	Sequence  uint64
	// Hash of the subject, computed once by the receiver so every sharded
	// structure downstream can route without hashing again.
	Hash uint32
	// classification of Data, computed on first use
	kind atomic.Int32
}

var hashSeed = maphash.MakeSeed()

// SubjectHash is the routing hash used for Record.Hash.
func SubjectHash(subject string) uint32 {
	return uint32(maphash.String(hashSeed, subject))
}

const (
	kindUnknown int32 = iota
	kindString
	kindJSON
	kindBinary
)

// NewRecord wraps a delivered message.
func NewRecord(msg *nats.Msg, seq uint64, now int64) *Record {
	return &Record{Subject: msg.Subject, Data: msg.Data, Header: msg.Header, Reply: msg.Reply, Timestamp: now, Sequence: seq, Hash: SubjectHash(msg.Subject)}
}

// Kind classifies the payload as "string", "json" or "binary", once.
func (r *Record) Kind() string {
	k := r.kind.Load()
	if k == kindUnknown {
		switch {
		case !utf8.Valid(r.Data):
			k = kindBinary
		case len(r.Data) > 0 && (r.Data[0] == '{' || r.Data[0] == '[') && json.Valid(r.Data):
			k = kindJSON
		default:
			k = kindString
		}
		r.kind.Store(k)
	}
	switch k {
	case kindJSON:
		return "json"
	case kindBinary:
		return "binary"
	default:
		return "string"
	}
}

// Text returns the payload for the browser: the text itself, or base64 for
// binary data.
func (r *Record) Text() string {
	if r.Kind() == "binary" {
		return base64.StdEncoding.EncodeToString(r.Data)
	}
	return string(r.Data)
}

// Bytes estimates the memory a record occupies in the history, for its
// budget: the strings plus the structs and slots that hold it. Measured
// against RSS under load.
func (r *Record) Bytes() int {
	n := len(r.Subject) + len(r.Data) + len(r.Reply) + 320
	for k, vals := range r.Header {
		n += len(k) + 32
		for _, v := range vals {
			n += len(v) + 16
		}
	}
	return n
}

// Wire builds the browser form of the record.
func (r *Record) Wire(connID string) NatsMessage {
	m := NatsMessage{
		Subject:     r.Subject,
		Payload:     r.Text(),
		PayloadType: r.Kind(),
		Timestamp:   r.Timestamp,
		Reply:       r.Reply,
		Size:        len(r.Data),
		Sequence:    r.Sequence,
		ConnID:      connID,
	}
	if len(r.Header) > 0 {
		m.Headers = make(map[string][]string, len(r.Header))
		for k, v := range r.Header {
			m.Headers[k] = v
		}
	}
	return m
}

// EncodePayload classifies raw bytes into the wire representation.
func EncodePayload(data []byte) (payload string, payloadType string) {
	if !utf8.Valid(data) {
		return base64.StdEncoding.EncodeToString(data), "binary"
	}
	payload = string(data)
	if len(data) > 0 && (data[0] == '{' || data[0] == '[') && json.Valid(data) {
		return payload, "json"
	}
	return payload, "string"
}

// DecodePayload is the inverse of EncodePayload: it turns a wire payload
// back into the bytes that were received. Used when a recorded message is
// replayed into the pipeline, e.g. from a support bundle.
func DecodePayload(payload, payloadType string) ([]byte, error) {
	if payloadType == "binary" {
		return base64.StdEncoding.DecodeString(payload)
	}
	return []byte(payload), nil
}
